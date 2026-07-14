use crate::{
    analysis::{AnalysisState, AssetAnalysis, SceneAnalysis, VisualObservation},
    domain::{
        apply_command, transform_at_offset, validate_project, AppState, CaptionCue, CaptionStyle, EditCommand, EditorProject, EffectInstance, TimelineClip,
        TimelineTrack, Transform, TransformKeyframe,
    },
    error::AppError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

fn retryable_gemini_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::REQUEST_TIMEOUT || status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn gemini_retry_delay(attempt: u32) -> Duration {
    let jitter = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| u64::from(duration.subsec_millis() % 250));
    Duration::from_millis((1_u64 << attempt.min(3)) * 1_000 + jitter)
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis() as u64)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<EditProposal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<AgentQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_request: Option<AgentAnalysisRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAnalysisRequest {
    pub asset_id: String,
    pub prompts: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditProposal {
    pub id: String,
    pub base_revision: u64,
    pub summary: String,
    pub rationale: String,
    pub confidence: String,
    pub operations: Vec<EditCommand>,
    pub evidence: Vec<ProposalEvidence>,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalEvidence {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub start_tick: i64,
    pub end_tick: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestion {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentChatTurn {
    role: String,
    text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelection {
    #[serde(default)]
    clip_ids: Vec<String>,
    asset_id: Option<String>,
    track_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolArgs {
    message: Option<String>,
    rationale: Option<String>,
    confidence: Option<String>,
    #[serde(default)]
    evidence: Vec<AgentEvidenceRef>,
    operations: Vec<AgentOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvidenceRef {
    kind: Option<String>,
    label: Option<String>,
    asset_id: Option<String>,
    scene_id: Option<String>,
    observation_id: Option<String>,
    start_tick: Option<i64>,
    end_tick: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AgentQuestionArgs {
    question: String,
    context: Option<String>,
    options: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentAnalysisArgs {
    asset_id: Option<String>,
    prompts: Vec<String>,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentOperation {
    kind: String,
    track_id: Option<String>,
    clip_id: Option<String>,
    asset_id: Option<String>,
    start_tick: Option<i64>,
    source_in_tick: Option<i64>,
    duration_ticks: Option<i64>,
    at_tick: Option<i64>,
    ripple: Option<bool>,
    value: Option<f64>,
    effect_kind: Option<String>,
    edge: Option<String>,
    transition_kind: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    scale: Option<f64>,
    rotation: Option<f64>,
    crop_top: Option<f64>,
    crop_right: Option<f64>,
    crop_bottom: Option<f64>,
    crop_left: Option<f64>,
    aspect_ratio: Option<String>,
    fit_mode: Option<String>,
    font_family: Option<String>,
    font_size: Option<u32>,
    text_color: Option<String>,
    background: Option<bool>,
    background_color: Option<String>,
    uppercase: Option<bool>,
    bold: Option<bool>,
    position: Option<String>,
    min_silence_ticks: Option<i64>,
    padding_ticks: Option<i64>,
    caption_id: Option<String>,
    text: Option<String>,
    observation_id: Option<String>,
    easing: Option<String>,
    end_x: Option<f64>,
    end_y: Option<f64>,
    end_scale: Option<f64>,
    end_rotation: Option<f64>,
}

fn prompt_terms(prompt: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for term in prompt.to_lowercase().split(|character: char| !character.is_alphanumeric()) {
        if term.chars().count() < 3 || terms.iter().any(|existing| existing == term) { continue; }
        terms.push(term.to_string());
        if terms.len() == 24 { break; }
    }
    terms
}

fn relevance(text: &str, terms: &[String]) -> usize {
    let normalized = text.to_lowercase();
    terms.iter().filter(|term| normalized.contains(term.as_str())).count()
}

fn compact_context(project: &EditorProject, selection: &AgentSelection, analyses: &[AssetAnalysis], prompt: &str) -> Value {
    let terms = prompt_terms(prompt);
    let assets = project.assets.iter().map(|asset| json!({
        "id": asset.id,
        "name": asset.name,
        "durationTicks": asset.duration_ticks,
        "width": asset.width,
        "height": asset.height,
        "fps": asset.fps,
        "codec": asset.codec,
        "hasAudio": asset.has_audio,
        "hasTranscript": project.transcripts.iter().any(|transcript| transcript.asset_id == asset.id),
        "hasVisualAnalysis": analyses.iter().any(|analysis| analysis.asset_id == asset.id),
        "offline": asset.offline,
    })).collect::<Vec<_>>();
    let sequence = project.active_sequence().map(|sequence| json!({
        "id": sequence.id,
        "name": sequence.name,
        "tracks": sequence.tracks.iter().map(|track| json!({
            "id": track.id,
            "name": track.name,
            "kind": track.kind,
            "locked": track.locked,
            "muted": track.muted,
            "hidden": track.hidden,
            "clips": track.clips.iter().map(|clip| json!({
                "id": clip.id,
                "assetId": clip.asset_id,
                "name": clip.name,
                "startTick": clip.start_tick,
                "sourceInTick": clip.source_in_tick,
                "durationTicks": clip.duration_ticks,
                "speed": clip.speed,
                "volume": clip.volume,
                "transform": clip.transform,
                "keyframes": clip.keyframes,
                "effects": clip.effects,
                "transitionIn": clip.transition_in,
                "transitionOut": clip.transition_out,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "captions": sequence.captions,
        "captionStyle": sequence.caption_style,
        "markers": sequence.markers,
    }));
    let transcripts = project.transcripts.iter().map(|transcript| {
        let mut segments = transcript.segments.iter().enumerate().map(|(index, segment)| {
            let score = relevance(&segment.text, &terms)
                + usize::from(selection.asset_id.as_deref() == Some(transcript.asset_id.as_str()));
            (index, score, segment)
        }).collect::<Vec<_>>();
        if segments.len() > 360 {
            if segments.iter().any(|(_, score, _)| *score > 0) {
                segments.sort_by_key(|(index, score, _)| (std::cmp::Reverse(*score), *index));
                segments.truncate(360);
                segments.sort_by_key(|(index, _, _)| *index);
            } else {
                let step = segments.len() as f64 / 360.0;
                segments = (0..360).filter_map(|index| segments.get((index as f64 * step).floor() as usize).copied()).collect();
            }
        }
        json!({
            "assetId": transcript.asset_id,
            "language": transcript.language,
            "segments": segments.into_iter().map(|(_, _, segment)| json!({
                "id": segment.id,
                "startTick": segment.start_tick,
                "endTick": segment.end_tick,
                "text": segment.text,
                "speaker": segment.speaker,
                "confidence": segment.confidence,
                "words": segment.words.as_ref().map(|words| words.iter().take(80).map(|word| json!({
                    "text": word.text,
                    "startTick": word.start_tick,
                    "endTick": word.end_tick,
                    "confidence": word.confidence,
                })).collect::<Vec<_>>()),
            })).collect::<Vec<_>>(),
        })
    }).collect::<Vec<_>>();
    let visual_analysis = analyses.iter().map(|analysis| {
        let mut scenes = analysis.scenes.iter().enumerate().map(|(index, scene)| {
            let searchable = scene.observations.iter().map(|observation| format!("{} {}", observation.label, observation.text.as_deref().unwrap_or_default())).collect::<Vec<_>>().join(" ");
            let score = relevance(&searchable, &terms)
                + usize::from(selection.asset_id.as_deref() == Some(analysis.asset_id.as_str()));
            (index, score, scene)
        }).collect::<Vec<_>>();
        if scenes.len() > 120 {
            if scenes.iter().any(|(_, score, _)| *score > 0) {
                scenes.sort_by_key(|(index, score, _)| (std::cmp::Reverse(*score), *index));
                scenes.truncate(120);
                scenes.sort_by_key(|(index, _, _)| *index);
            } else {
                let step = scenes.len() as f64 / 120.0;
                scenes = (0..120).filter_map(|index| scenes.get((index as f64 * step).floor() as usize).copied()).collect();
            }
        }
        json!({
            "assetId": analysis.asset_id,
            "pipelineVersion": analysis.pipeline_version,
            "stages": analysis.stages,
            "scenes": scenes.into_iter().map(|(_, _, scene)| json!({
                "id": scene.id,
                "startTick": scene.start_tick,
                "endTick": scene.end_tick,
                "representativeTick": scene.representative_tick,
                "motionScore": scene.motion_score,
                "observations": scene.observations,
            })).collect::<Vec<_>>(),
        })
    }).collect::<Vec<_>>();
    json!({
        "settings": project.settings,
        "revision": project.revision,
        "assets": assets,
        "sequence": sequence,
        "transcripts": transcripts,
        "visualAnalysis": visual_analysis,
        "selection": selection,
    })
}

fn resolve_clip_target(
    project: &EditorProject,
    selection: &AgentSelection,
    requested_track_id: Option<&str>,
    requested_clip_id: Option<&str>,
    requested_asset_id: Option<&str>,
) -> Result<(String, String), AppError> {
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let matching = |track_id: Option<&str>, clip_id: Option<&str>, asset_id: Option<&str>| {
        sequence.tracks.iter()
            .filter(move |track| track.kind != "caption" && track_id.map_or(true, |id| track.id == id))
            .flat_map(move |track| track.clips.iter()
                .filter(move |clip| clip_id.map_or(true, |id| clip.id == id) && asset_id.map_or(true, |id| clip.asset_id == id))
                .map(move |clip| (track.id.clone(), clip.id.clone())))
            .collect::<Vec<_>>()
    };

    if requested_track_id.is_some() || requested_clip_id.is_some() || requested_asset_id.is_some() {
        let targets = matching(requested_track_id, requested_clip_id, requested_asset_id);
        if targets.len() == 1 { return Ok(targets[0].clone()); }
        if targets.is_empty() && requested_track_id.is_some() && requested_clip_id.is_none() {
            let selected_clip = selection.clip_ids.first().map(String::as_str);
            let selected = matching(requested_track_id, selected_clip, requested_asset_id);
            if selected.len() == 1 { return Ok(selected[0].clone()); }
        }
        return Err(if targets.is_empty() {
            AppError::new("AGENT_TARGET", "O agente referenciou uma mídia, faixa ou clipe inexistente")
        } else {
            AppError::new("AGENT_TARGET_AMBIGUOUS", "O alvo da edição é ambíguo; informe o clipe ou use um escopo explícito")
        });
    }

    if let Some(selected_clip) = selection.clip_ids.first() {
        let targets = matching(selection.track_id.as_deref(), Some(selected_clip), selection.asset_id.as_deref());
        if targets.len() == 1 { return Ok(targets[0].clone()); }
    }
    if let Some(selected_track) = selection.track_id.as_deref() {
        let targets = matching(Some(selected_track), None, selection.asset_id.as_deref());
        if targets.len() == 1 { return Ok(targets[0].clone()); }
    }
    let targets = matching(None, None, selection.asset_id.as_deref());
    if targets.len() == 1 { return Ok(targets[0].clone()); }
    Err(AppError::new("AGENT_TARGET_AMBIGUOUS", "Há mais de um clipe possível; selecione um clipe ou forneça clipId"))
}

fn captions_from_transcript(project: &EditorProject, asset_id: &str) -> Result<Vec<CaptionCue>, AppError> {
    let transcript = project.transcripts.iter().find(|item| item.asset_id == asset_id).ok_or_else(|| AppError::new("TRANSCRIPT_REQUIRED", "Transcrição não encontrada"))?;
    let placements = project.active_sequence().into_iter().flat_map(|sequence| sequence.tracks.iter()).flat_map(|track| track.clips.iter()).filter(|clip| clip.asset_id == asset_id).collect::<Vec<_>>();
    let mut captions = Vec::new();
    if placements.is_empty() {
        captions.extend(transcript.segments.iter().map(|segment| CaptionCue { id: format!("caption-{}", Uuid::new_v4()), start_tick: segment.start_tick, end_tick: segment.end_tick, text: segment.text.clone() }));
    } else {
        for clip in placements {
            let source_start = clip.source_in_tick;
            let source_end = source_start + (clip.duration_ticks as f64 * clip.speed).round() as i64;
            for segment in &transcript.segments {
                let overlap_start = segment.start_tick.max(source_start);
                let overlap_end = segment.end_tick.min(source_end);
                if overlap_end <= overlap_start { continue; }
                captions.push(CaptionCue {
                    id: format!("caption-{}", Uuid::new_v4()),
                    start_tick: clip.start_tick + ((overlap_start - source_start) as f64 / clip.speed).round() as i64,
                    end_tick: clip.start_tick + ((overlap_end - source_start) as f64 / clip.speed).round() as i64,
                    text: segment.text.clone(),
                });
            }
        }
        captions.sort_by_key(|cue| cue.start_tick);
    }
    Ok(captions)
}

fn canvas_dimensions(aspect_ratio: &str) -> Result<(u32, u32), AppError> {
    match aspect_ratio {
        "9:16" => Ok((1080, 1920)),
        "16:9" => Ok((1920, 1080)),
        "1:1" => Ok((1080, 1080)),
        "4:5" => Ok((1080, 1350)),
        _ => Err(AppError::new("AGENT_CANVAS", "Proporção de vídeo não permitida")),
    }
}

fn canvas_commands(project: &EditorProject, operation: &AgentOperation) -> Result<Vec<EditCommand>, AppError> {
    let aspect_ratio = operation.aspect_ratio.as_deref().ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setCanvas requer aspectRatio"))?;
    let (width, height) = canvas_dimensions(aspect_ratio)?;
    let mut settings = project.settings.clone();
    settings.width = width;
    settings.height = height;
    let mut commands = vec![EditCommand::SetProjectSettings { settings }];
    if operation.fit_mode.as_deref().unwrap_or("cover") == "contain" { return Ok(commands); }
    if !matches!(operation.fit_mode.as_deref(), None | Some("cover")) { return Err(AppError::new("AGENT_CANVAS", "fitMode deve ser cover ou contain")); }
    let canvas_aspect = width as f64 / height as f64;
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    for track in sequence.tracks.iter().filter(|track| track.kind == "video" && !track.locked) {
        for clip in &track.clips {
            let Some(asset) = project.assets.iter().find(|asset| asset.id == clip.asset_id) else { continue; };
            let (Some(asset_width), Some(asset_height)) = (asset.width, asset.height) else { continue; };
            let asset_aspect = asset_width as f64 / asset_height as f64;
            let cover_scale = if asset_aspect > canvas_aspect { asset_aspect / canvas_aspect } else { canvas_aspect / asset_aspect };
            let mut transform = clip.transform.clone();
            transform.scale = cover_scale.clamp(1.0, 10.0);
            commands.push(EditCommand::UpdateClip { track_id: track.id.clone(), clip_id: clip.id.clone(), patch: json!({"transform": transform}) });
        }
    }
    Ok(commands)
}

fn normalized_color(value: &str) -> Result<String, AppError> {
    let normalized = value.trim().to_uppercase();
    if normalized.len() == 7 && normalized.starts_with('#') && normalized[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(normalized)
    } else {
        Err(AppError::new("AGENT_CAPTION_STYLE", "A cor deve usar o formato hexadecimal #RRGGBB"))
    }
}

fn caption_style_command(project: &EditorProject, operation: &AgentOperation) -> Result<EditCommand, AppError> {
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let mut style: CaptionStyle = sequence.caption_style.clone();
    if let Some(value) = operation.font_family.as_deref() {
        if !matches!(value, "modern" | "mono" | "serif") { return Err(AppError::new("AGENT_CAPTION_STYLE", "Fonte de legenda não permitida")); }
        style.font_family = value.into();
    }
    if let Some(value) = operation.font_size { style.font_size = value.clamp(12, 160); }
    if let Some(value) = operation.text_color.as_deref() { style.text_color = normalized_color(value)?; }
    if let Some(value) = operation.background { style.background = value; }
    if let Some(value) = operation.background_color.as_deref() { style.background_color = normalized_color(value)?; }
    if let Some(value) = operation.uppercase { style.uppercase = value; }
    if let Some(value) = operation.bold { style.bold = value; }
    if let Some(value) = operation.position.as_deref() {
        if !matches!(value, "top" | "center" | "bottom") { return Err(AppError::new("AGENT_CAPTION_STYLE", "Posição de legenda não permitida")); }
        style.position = value.into();
    }
    Ok(EditCommand::SetCaptionStyle { sequence_id: sequence.id.clone(), style })
}

fn keyframe_easing(operation: &AgentOperation) -> Result<String, AppError> {
    let easing = operation.easing.as_deref().unwrap_or("easeInOut");
    if !matches!(easing, "linear" | "easeIn" | "easeOut" | "easeInOut") {
        return Err(AppError::new("AGENT_KEYFRAME", "Easing deve ser linear, easeIn, easeOut ou easeInOut"));
    }
    Ok(easing.into())
}

fn operation_transform(base: &Transform, operation: &AgentOperation, ending: bool, project: &EditorProject) -> Transform {
    let mut transform = base.clone();
    let x = if ending { operation.end_x } else { operation.x };
    let y = if ending { operation.end_y } else { operation.y };
    let scale = if ending { operation.end_scale } else { operation.scale };
    let rotation = if ending { operation.end_rotation } else { operation.rotation };
    if let Some(value) = x { transform.x = value.clamp(-(project.settings.width as f64), project.settings.width as f64); }
    if let Some(value) = y { transform.y = value.clamp(-(project.settings.height as f64), project.settings.height as f64); }
    if let Some(value) = scale { transform.scale = value.clamp(0.01, 10.0); }
    if let Some(value) = rotation { transform.rotation = value.clamp(-360.0, 360.0); }
    transform
}

fn animate_transform_command(project: &EditorProject, selection: &AgentSelection, operation: &AgentOperation) -> Result<EditCommand, AppError> {
    let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
    let clip = project.active_sequence().and_then(|sequence| sequence.tracks.iter().find(|track| track.id == track_id))
        .and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id))
        .ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
    let duration = operation.duration_ticks.unwrap_or(clip.duration_ticks).clamp(1, clip.duration_ticks);
    let easing = keyframe_easing(operation)?;
    let start = operation_transform(&clip.transform, operation, false, project);
    let end = operation_transform(&start, operation, true, project);
    if start == end { return Err(AppError::new("AGENT_KEYFRAME", "animateTransform requer ao menos um valor final diferente")); }
    let keyframes = vec![
        TransformKeyframe { id: format!("keyframe-{}", Uuid::new_v4()), offset_tick: 0, easing: easing.clone(), value: start },
        TransformKeyframe { id: format!("keyframe-{}", Uuid::new_v4()), offset_tick: duration, easing, value: end },
    ];
    Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"keyframes": keyframes}) })
}

fn find_observation<'a>(analyses: &'a [AssetAnalysis], observation_id: &str) -> Option<(&'a AssetAnalysis, &'a SceneAnalysis, &'a VisualObservation)> {
    analyses.iter().find_map(|analysis| analysis.scenes.iter().find_map(|scene| {
        scene.observations.iter().find(|observation| observation.id == observation_id).map(|observation| (analysis, scene, observation))
    }))
}

fn focus_observation_command(project: &EditorProject, selection: &AgentSelection, analyses: &[AssetAnalysis], operation: &AgentOperation) -> Result<EditCommand, AppError> {
    let observation_id = operation.observation_id.as_deref().ok_or_else(|| AppError::new("AGENT_ARGUMENT", "focusObservation requer observationId"))?;
    let (analysis, scene, observation) = find_observation(analyses, observation_id)
        .ok_or_else(|| AppError::new("AGENT_OBSERVATION", "A observação visual indicada não está disponível"))?;
    let requested_asset = operation.asset_id.as_deref().or(Some(analysis.asset_id.as_str()));
    let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), requested_asset)?;
    let clip = project.active_sequence().and_then(|sequence| sequence.tracks.iter().find(|track| track.id == track_id))
        .and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id))
        .ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
    let source_end = clip.source_in_tick + (clip.duration_ticks as f64 * clip.speed).round() as i64;
    let focus_source_start = scene.start_tick.max(observation.start_tick).max(clip.source_in_tick);
    let focus_source_end = scene.end_tick.min(observation.end_tick).min(source_end);
    if focus_source_end <= focus_source_start {
        return Err(AppError::new("AGENT_OBSERVATION_RANGE", "A observação visual não ocorre dentro do clipe alvo"));
    }
    let focus_start = ((focus_source_start - clip.source_in_tick) as f64 / clip.speed).round() as i64;
    let focus_end = ((focus_source_end - clip.source_in_tick) as f64 / clip.speed).round() as i64;
    let transition = operation.duration_ticks.unwrap_or(project.settings.timebase / 3).clamp(1, project.settings.timebase * 2);
    let center_x = observation.rect.x + observation.rect.width / 2.0;
    let center_y = observation.rect.y + observation.rect.height / 2.0;
    let target_scale = operation.scale.unwrap_or_else(|| (0.62 / observation.rect.width.max(observation.rect.height).max(0.05)).clamp(1.15, 4.0));
    let mut focused = clip.transform.clone();
    focused.scale = target_scale.clamp(1.0, 10.0);
    focused.x = ((0.5 - center_x) * project.settings.width as f64 * focused.scale).clamp(-(project.settings.width as f64), project.settings.width as f64);
    focused.y = ((0.5 - center_y) * project.settings.height as f64 * focused.scale).clamp(-(project.settings.height as f64), project.settings.height as f64);
    let easing = keyframe_easing(operation)?;
    let mut keyframes = clip.keyframes.clone();
    let points = [
        (focus_start.saturating_sub(transition), clip.transform.clone()),
        (focus_start, focused.clone()),
        (focus_end, focused),
        ((focus_end + transition).min(clip.duration_ticks), clip.transform.clone()),
    ];
    for (offset_tick, value) in points {
        keyframes.retain(|keyframe| keyframe.offset_tick != offset_tick);
        keyframes.push(TransformKeyframe { id: format!("keyframe-{}", Uuid::new_v4()), offset_tick, easing: easing.clone(), value });
    }
    keyframes.sort_by_key(|keyframe| keyframe.offset_tick);
    Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"keyframes": keyframes}) })
}

fn silence_removal_commands(project: &EditorProject, selection: &AgentSelection, operation: &AgentOperation) -> Result<Vec<EditCommand>, AppError> {
    let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let track = sequence.tracks.iter().find(|track| track.id == track_id).ok_or_else(|| AppError::new("TRACK_NOT_FOUND", "Faixa não encontrada"))?;
    if track.locked { return Err(AppError::new("TRACK_LOCKED", "A faixa de destino está bloqueada")); }
    let original = track.clips.iter().find(|clip| clip.id == clip_id).cloned().ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
    let transcript = project.transcripts.iter().find(|transcript| transcript.asset_id == original.asset_id).ok_or_else(|| AppError::new("TRANSCRIPT_REQUIRED", "A remoção automática de pausas requer a transcrição desta mídia"))?;
    let source_start = original.source_in_tick;
    let source_end = source_start + (original.duration_ticks as f64 * original.speed).round() as i64;
    let minimum = operation.min_silence_ticks.unwrap_or(288_000).clamp(72_000, 2_400_000);
    let padding = operation.padding_ticks.unwrap_or(24_000).clamp(0, minimum / 3);
    let mut speech = transcript.segments.iter()
        .map(|segment| (segment.start_tick.max(source_start), segment.end_tick.min(source_end)))
        .filter(|(start, end)| end > start)
        .collect::<Vec<_>>();
    speech.sort_by_key(|range| range.0);
    if speech.is_empty() { return Err(AppError::new("TRANSCRIPT_EMPTY", "A transcrição não contém fala dentro do clipe")); }
    let mut merged = Vec::<(i64, i64)>::new();
    for (start, end) in speech {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) { last.1 = last.1.max(end); }
        else { merged.push((start, end)); }
    }
    let mut cuts = Vec::new();
    let mut cursor = source_start;
    for (start, end) in merged {
        if start - cursor > minimum {
            let cut_start = cursor + padding;
            let cut_end = start - padding;
            if cut_end > cut_start { cuts.push((cut_start, cut_end)); }
        }
        cursor = cursor.max(end);
    }
    if source_end - cursor > minimum {
        let cut_start = cursor + padding;
        let cut_end = source_end;
        if cut_end > cut_start { cuts.push((cut_start, cut_end)); }
    }
    if cuts.is_empty() { return Ok(Vec::new()); }
    let mut keep = Vec::new();
    cursor = source_start;
    for (cut_start, cut_end) in cuts {
        if cut_start > cursor { keep.push((cursor, cut_start)); }
        cursor = cut_end;
    }
    if cursor < source_end { keep.push((cursor, source_end)); }
    keep.retain(|(start, end)| end > start);

    let mut commands = vec![EditCommand::DeleteClip { track_id: track_id.clone(), clip_id: clip_id.clone(), ripple: false }];
    let mut timeline_cursor = original.start_tick;
    let keep_count = keep.len();
    for (index, (start, end)) in keep.iter().enumerate() {
        let mut clip: TimelineClip = original.clone();
        let original_offset = (((start - source_start) as f64 / original.speed).round() as i64).max(0);
        let segment_duration = (((end - start) as f64 / original.speed).round() as i64).max(1);
        clip.id = if index == 0 { original.id.clone() } else { format!("clip-{}", Uuid::new_v4()) };
        clip.start_tick = timeline_cursor;
        clip.source_in_tick = *start;
        clip.duration_ticks = segment_duration;
        clip.transform = transform_at_offset(&original, original_offset);
        clip.keyframes = original.keyframes.iter().filter(|keyframe| keyframe.offset_tick > original_offset && keyframe.offset_tick <= original_offset + segment_duration).cloned().map(|mut keyframe| {
            keyframe.offset_tick -= original_offset;
            keyframe
        }).collect();
        clip.transition_in = (index == 0).then(|| original.transition_in.clone()).flatten();
        clip.transition_out = (index + 1 == keep_count).then(|| original.transition_out.clone()).flatten();
        timeline_cursor += clip.duration_ticks;
        commands.push(EditCommand::InsertClip { track_id: track_id.clone(), clip });
    }
    let kept_duration = timeline_cursor - original.start_tick;
    let removed_duration = original.duration_ticks - kept_duration;
    let original_end = original.start_tick + original.duration_ticks;
    for candidate_track in sequence.tracks.iter().filter(|track| !track.locked && track.kind != "caption") {
        for clip in candidate_track.clips.iter().filter(|clip| clip.id != original.id && clip.start_tick >= original_end) {
            commands.push(EditCommand::MoveClip { track_id: candidate_track.id.clone(), clip_id: clip.id.clone(), start_tick: (clip.start_tick - removed_duration).max(0) });
        }
    }
    if !sequence.captions.is_empty() {
        let mut preview = project.clone();
        for command in &commands { apply_command(&mut preview, command.clone())?; }
        let captions = captions_from_transcript(&preview, &original.asset_id)?;
        commands.push(EditCommand::SetCaptions { sequence_id: sequence.id.clone(), captions });
    }
    Ok(commands)
}

fn insert_asset_commands(project: &EditorProject, operation: &AgentOperation) -> Result<Vec<EditCommand>, AppError> {
    let asset_id = operation.asset_id.as_deref().ok_or_else(|| AppError::new("AGENT_ARGUMENT", "insertAsset requer assetId"))?;
    let asset = project.assets.iter().find(|asset| asset.id == asset_id && !asset.offline)
        .ok_or_else(|| AppError::new("ASSET_NOT_FOUND", "A mídia complementar não está disponível"))?;
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let track_kind = if asset.width.is_some() && asset.height.is_some() { "video" } else { "audio" };
    let requested_track = operation.track_id.as_deref().map(|track_id| sequence.tracks.iter().find(|track| track.id == track_id)
        .ok_or_else(|| AppError::new("TRACK_NOT_FOUND", "Faixa de inserção não encontrada"))).transpose()?;
    if requested_track.is_some_and(|track| track.kind != track_kind || track.locked) {
        return Err(AppError::new("AGENT_TRACK", "A faixa indicada é incompatível ou está bloqueada"));
    }
    let existing_track = requested_track.or_else(|| sequence.tracks.iter().find(|track| track.kind == track_kind && !track.locked));
    let mut commands = Vec::new();
    let track_id = if let Some(track) = existing_track {
        track.id.clone()
    } else {
        let track_id = format!("track-{track_kind}-{}", Uuid::new_v4());
        let number = sequence.tracks.iter().filter(|track| track.kind == track_kind).count() + 1;
        commands.push(EditCommand::AddTrack {
            sequence_id: sequence.id.clone(),
            track: TimelineTrack {
                id: track_id.clone(), name: format!("{}{}", if track_kind == "video" { "V" } else { "A" }, number),
                kind: track_kind.into(), locked: false, muted: false, hidden: false, clips: Vec::new(),
            },
        });
        track_id
    };
    let source_in_tick = operation.source_in_tick.unwrap_or(0).clamp(0, asset.duration_ticks.saturating_sub(1));
    let available = asset.duration_ticks.saturating_sub(source_in_tick).max(1);
    let duration_ticks = operation.duration_ticks.unwrap_or(available).clamp(1, available);
    let start_tick = operation.start_tick.or(operation.at_tick).unwrap_or_else(|| sequence_duration(project)).max(0);
    let clip = TimelineClip {
        id: format!("clip-{}", Uuid::new_v4()), asset_id: asset.id.clone(), name: asset.name.clone(), start_tick, source_in_tick,
        duration_ticks, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: Vec::new(), effects: Vec::new(),
        transition_in: None, transition_out: None,
    };
    commands.push(EditCommand::InsertClip { track_id, clip });
    Ok(commands)
}

fn operation_to_command_with_selection(project: &EditorProject, selection: &AgentSelection, operation: AgentOperation) -> Result<EditCommand, AppError> {
    match operation.kind.as_str() {
        "deleteClip" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            Ok(EditCommand::DeleteClip { track_id, clip_id, ripple: operation.ripple.unwrap_or(false) })
        }
        "moveClip" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            Ok(EditCommand::MoveClip { track_id, clip_id, start_tick: operation.start_tick.unwrap_or_default().max(0) })
        }
        "trimClip" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            Ok(EditCommand::TrimClip {
                track_id,
                clip_id,
                source_in_tick: operation.source_in_tick.unwrap_or_default().max(0),
                duration_ticks: operation.duration_ticks.unwrap_or(1).max(1),
            })
        }
        "splitClip" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            Ok(EditCommand::SplitClip { track_id, clip_id, at_tick: operation.at_tick.unwrap_or_default(), right_clip_id: format!("clip-{}", Uuid::new_v4()) })
        }
        "setVolume" | "setSpeed" | "setOpacity" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            let value = operation.value.unwrap_or(1.0);
            let patch = if operation.kind == "setOpacity" {
                let sequence = project.active_sequence().unwrap();
                let clip = sequence.tracks.iter().find(|track| track.id == track_id).and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).unwrap();
                let mut transform = serde_json::to_value(&clip.transform)?;
                transform["opacity"] = json!(value.clamp(0.0, 1.0));
                json!({"transform": transform})
            } else if operation.kind == "setVolume" {
                json!({"volume": value.clamp(0.0, 4.0)})
            } else {
                json!({"speed": value.clamp(0.05, 20.0)})
            };
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch })
        }
        "setTransform" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            let clip = project.active_sequence().unwrap().tracks.iter().find(|track| track.id == track_id).and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).unwrap();
            let mut transform = clip.transform.clone();
            if let Some(value) = operation.x { transform.x = value.clamp(-(project.settings.width as f64), project.settings.width as f64); }
            if let Some(value) = operation.y { transform.y = value.clamp(-(project.settings.height as f64), project.settings.height as f64); }
            if let Some(value) = operation.scale { transform.scale = value.clamp(0.01, 10.0); }
            if let Some(value) = operation.rotation { transform.rotation = value.clamp(-360.0, 360.0); }
            if let Some(value) = operation.crop_top { transform.crop_top = value.clamp(0.0, 0.49); }
            if let Some(value) = operation.crop_right { transform.crop_right = value.clamp(0.0, 0.49); }
            if let Some(value) = operation.crop_bottom { transform.crop_bottom = value.clamp(0.0, 0.49); }
            if let Some(value) = operation.crop_left { transform.crop_left = value.clamp(0.0, 0.49); }
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"transform": transform}) })
        }
        "addEffect" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            let effect_kind = operation.effect_kind.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "addEffect requer effectKind"))?;
            if !matches!(effect_kind.as_str(), "exposure" | "contrast" | "saturation" | "temperature" | "chromaKey" | "blur") { return Err(AppError::new("AGENT_EFFECT", "Efeito não permitido")); }
            let clip = project.active_sequence().unwrap().tracks.iter().find(|track| track.id == track_id).and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).unwrap();
            let mut effects = clip.effects.clone();
            effects.push(EffectInstance { id: format!("effect-{}", Uuid::new_v4()), kind: effect_kind, enabled: true, value: operation.value.unwrap_or(0.0).clamp(-1.0, 1.0) });
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"effects": effects}) })
        }
        "setTransition" => {
            let (track_id, clip_id) = resolve_clip_target(project, selection, operation.track_id.as_deref(), operation.clip_id.as_deref(), operation.asset_id.as_deref())?;
            let transition_kind = operation.transition_kind.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransition requer transitionKind"))?;
            if !matches!(transition_kind.as_str(), "crossDissolve" | "dipToBlack" | "slide" | "audioCrossfade") { return Err(AppError::new("AGENT_TRANSITION", "Transição não permitida")); }
            let clip_duration = project.active_sequence().and_then(|sequence| sequence.tracks.iter().find(|track| track.id == track_id))
                .and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).map_or(720_000, |clip| clip.duration_ticks);
            let duration_ticks = operation.duration_ticks.unwrap_or(120_000).clamp(1, 720_000.min(clip_duration));
            let transition = json!({"kind": transition_kind, "durationTicks": duration_ticks});
            let patch = match operation.edge.as_deref() {
                Some("out") => json!({"transitionOut": transition}),
                Some("in") => json!({"transitionIn": transition}),
                _ => return Err(AppError::new("AGENT_ARGUMENT", "setTransition requer edge in ou out")),
            };
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch })
        }
        "createCaptions" => {
            let asset_id = operation.asset_id.or_else(|| selection.asset_id.clone()).or_else(|| (project.transcripts.len() == 1).then(|| project.transcripts[0].asset_id.clone())).ok_or_else(|| AppError::new("TRANSCRIPT_REQUIRED", "Selecione uma mídia transcrita ou forneça assetId para criar legendas"))?;
            let captions = captions_from_transcript(project, &asset_id)?;
            Ok(EditCommand::SetCaptions { sequence_id: project.active_sequence_id.clone(), captions })
        }
        other => Err(AppError::new("AGENT_OPERATION", format!("Operação não permitida: {other}"))),
    }
}

#[cfg(test)]
fn operation_to_command(project: &EditorProject, operation: AgentOperation) -> Result<EditCommand, AppError> {
    operation_to_command_with_selection(project, &AgentSelection::default(), operation)
}

fn operation_to_commands(project: &EditorProject, selection: &AgentSelection, analyses: &[AssetAnalysis], operation: AgentOperation) -> Result<Vec<EditCommand>, AppError> {
    match operation.kind.as_str() {
        "insertAsset" => insert_asset_commands(project, &operation),
        "setCanvas" => canvas_commands(project, &operation),
        "removeSilences" => silence_removal_commands(project, selection, &operation),
        "setCaptionStyle" => Ok(vec![caption_style_command(project, &operation)?]),
        "animateTransform" => Ok(vec![animate_transform_command(project, selection, &operation)?]),
        "focusObservation" => Ok(vec![focus_observation_command(project, selection, analyses, &operation)?]),
        "setCaptionText" => {
            let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
            let caption_id = operation.caption_id.or_else(|| (sequence.captions.len() == 1).then(|| sequence.captions[0].id.clone())).ok_or_else(|| AppError::new("AGENT_CAPTION", "setCaptionText requer captionId quando há mais de uma legenda"))?;
            let text = operation.text.unwrap_or_default().trim().chars().take(500).collect::<String>();
            if text.is_empty() { return Err(AppError::new("AGENT_CAPTION", "O texto da legenda não pode ficar vazio")); }
            if !sequence.captions.iter().any(|caption| caption.id == caption_id) { return Err(AppError::new("AGENT_CAPTION", "Legenda não encontrada")); }
            let captions = sequence.captions.iter().cloned().map(|mut caption| {
                if caption.id == caption_id { caption.text = text.clone(); }
                caption
            }).collect();
            Ok(vec![EditCommand::SetCaptions { sequence_id: sequence.id.clone(), captions }])
        }
        "clearCaptions" => Ok(vec![EditCommand::SetCaptions { sequence_id: project.active_sequence_id.clone(), captions: Vec::new() }]),
        _ => Ok(vec![operation_to_command_with_selection(project, selection, operation)?]),
    }
}

fn bounded_text(value: Option<String>, fallback: &str, maximum: usize) -> String {
    let value = value.unwrap_or_else(|| fallback.into()).trim().chars().take(maximum).collect::<String>();
    if value.is_empty() { fallback.into() } else { value }
}

fn sequence_duration(project: &EditorProject) -> i64 {
    project.active_sequence().into_iter().flat_map(|sequence| &sequence.tracks).flat_map(|track| &track.clips)
        .map(|clip| clip.start_tick + clip.duration_ticks).max().unwrap_or(0)
}

fn clip_evidence(project: &EditorProject, track_id: &str, clip_id: &str) -> Option<ProposalEvidence> {
    let clip = project.active_sequence()?.tracks.iter().find(|track| track.id == track_id)?.clips.iter().find(|clip| clip.id == clip_id)?;
    Some(ProposalEvidence {
        id: format!("evidence-{}", Uuid::new_v4()), kind: "timeline".into(), label: clip.name.clone(),
        start_tick: clip.start_tick, end_tick: clip.start_tick + clip.duration_ticks, asset_id: Some(clip.asset_id.clone()),
        scene_id: None, observation_id: None,
    })
}

fn command_evidence(project: &EditorProject, command: &EditCommand) -> Option<ProposalEvidence> {
    match command {
        EditCommand::DeleteClip { track_id, clip_id, .. }
        | EditCommand::MoveClip { track_id, clip_id, .. }
        | EditCommand::TrimClip { track_id, clip_id, .. }
        | EditCommand::SplitClip { track_id, clip_id, .. }
        | EditCommand::UpdateClip { track_id, clip_id, .. } => clip_evidence(project, track_id, clip_id),
        EditCommand::InsertClip { clip, .. } => Some(ProposalEvidence {
            id: format!("evidence-{}", Uuid::new_v4()), kind: "timeline".into(), label: clip.name.clone(),
            start_tick: clip.start_tick, end_tick: clip.start_tick + clip.duration_ticks, asset_id: Some(clip.asset_id.clone()),
            scene_id: None, observation_id: None,
        }),
        EditCommand::SetCaptions { captions, .. } if !captions.is_empty() => Some(ProposalEvidence {
            id: format!("evidence-{}", Uuid::new_v4()), kind: "transcript".into(), label: "Transcrição sincronizada".into(),
            start_tick: captions.first().map_or(0, |caption| caption.start_tick),
            end_tick: captions.last().map_or(0, |caption| caption.end_tick), asset_id: None, scene_id: None, observation_id: None,
        }),
        EditCommand::SetProjectSettings { .. } => Some(ProposalEvidence {
            id: format!("evidence-{}", Uuid::new_v4()), kind: "timeline".into(), label: "Sequência completa".into(),
            start_tick: 0, end_tick: sequence_duration(project), asset_id: None, scene_id: None, observation_id: None,
        }),
        _ => None,
    }
}

fn referenced_evidence(project: &EditorProject, analyses: &[AssetAnalysis], reference: AgentEvidenceRef) -> Result<ProposalEvidence, AppError> {
    if let Some(observation_id) = reference.observation_id.as_deref() {
        let (analysis, scene, observation) = find_observation(analyses, observation_id)
            .ok_or_else(|| AppError::new("AGENT_EVIDENCE", "A proposta citou uma observação visual inexistente"))?;
        return Ok(ProposalEvidence {
            id: format!("evidence-{}", Uuid::new_v4()),
            kind: if observation.kind == "text" { "ocr".into() } else { "object".into() },
            label: observation.text.clone().unwrap_or_else(|| observation.label.clone()),
            start_tick: observation.start_tick, end_tick: observation.end_tick, asset_id: Some(analysis.asset_id.clone()),
            scene_id: Some(scene.id.clone()), observation_id: Some(observation.id.clone()),
        });
    }
    if let Some(scene_id) = reference.scene_id.as_deref() {
        let (analysis, scene) = analyses.iter().find_map(|analysis| analysis.scenes.iter().find(|scene| scene.id == scene_id).map(|scene| (analysis, scene)))
            .ok_or_else(|| AppError::new("AGENT_EVIDENCE", "A proposta citou uma cena inexistente"))?;
        return Ok(ProposalEvidence {
            id: format!("evidence-{}", Uuid::new_v4()), kind: "scene".into(),
            label: bounded_text(reference.label, "Mudança de cena", 160), start_tick: scene.start_tick, end_tick: scene.end_tick,
            asset_id: Some(analysis.asset_id.clone()), scene_id: Some(scene.id.clone()), observation_id: None,
        });
    }
    let kind = reference.kind.as_deref().unwrap_or("timeline");
    if !matches!(kind, "timeline" | "transcript") { return Err(AppError::new("AGENT_EVIDENCE", "Tipo de evidência não permitido")); }
    if let Some(asset_id) = reference.asset_id.as_deref() {
        if !project.assets.iter().any(|asset| asset.id == asset_id) { return Err(AppError::new("AGENT_EVIDENCE", "A proposta citou uma mídia inexistente")); }
    }
    let maximum = if let Some(asset_id) = reference.asset_id.as_deref() {
        project.assets.iter().find(|asset| asset.id == asset_id).map_or_else(|| sequence_duration(project), |asset| asset.duration_ticks)
    } else { sequence_duration(project) };
    let start_tick = reference.start_tick.unwrap_or(0).clamp(0, maximum);
    let end_tick = reference.end_tick.unwrap_or(maximum).clamp(start_tick, maximum);
    Ok(ProposalEvidence {
        id: format!("evidence-{}", Uuid::new_v4()), kind: kind.into(), label: bounded_text(reference.label, if kind == "transcript" { "Trecho da transcrição" } else { "Trecho da timeline" }, 160),
        start_tick, end_tick, asset_id: reference.asset_id, scene_id: None, observation_id: None,
    })
}

fn push_unique_evidence(evidence: &mut Vec<ProposalEvidence>, candidate: ProposalEvidence) {
    let duplicate = evidence.iter().any(|item| item.kind == candidate.kind && item.asset_id == candidate.asset_id
        && item.scene_id == candidate.scene_id && item.observation_id == candidate.observation_id
        && item.start_tick == candidate.start_tick && item.end_tick == candidate.end_tick);
    if !duplicate && evidence.len() < 24 { evidence.push(candidate); }
}

fn plan_from_function_call_with_selection(project: &EditorProject, selection: &AgentSelection, analyses: &[AssetAnalysis], name: &str, args: &Value) -> Result<AgentResponse, AppError> {
    match name {
        "propose_edit_operations" => {
            let tool_args: AgentToolArgs = serde_json::from_value(args.clone()).map_err(|error| AppError::new("GEMINI_SCHEMA", error.to_string()).with_details(args.clone()))?;
            if tool_args.operations.len() > 64 { return Err(AppError::new("AGENT_LIMIT", "O plano excedeu 64 operações")); }
            if tool_args.evidence.len() > 24 { return Err(AppError::new("AGENT_LIMIT", "A proposta excedeu 24 evidências")); }
            let mut operations = Vec::new();
            let mut projected = project.clone();
            for operation in tool_args.operations {
                let expanded = operation_to_commands(&projected, selection, analyses, operation)?;
                for command in &expanded { apply_command(&mut projected, command.clone())?; }
                operations.extend(expanded);
            }
            if operations.len() > 256 { return Err(AppError::new("AGENT_LIMIT", "O plano expandido excedeu 256 comandos")); }
            validate_project(&projected)?;
            if operations.is_empty() {
                return Ok(AgentResponse { message: "Nenhuma alteração aplicável foi necessária.".into(), proposal: None, question: None, analysis_request: None });
            }
            let summary = bounded_text(tool_args.message, &format!("{} operações preparadas", operations.len()), 300);
            let rationale = bounded_text(tool_args.rationale, "A proposta segue o pedido e o contexto disponível da timeline.", 2_000);
            let confidence = match tool_args.confidence.as_deref() { Some("low") => "low", Some("high") => "high", _ => "medium" }.to_string();
            let mut evidence = Vec::new();
            for reference in tool_args.evidence { push_unique_evidence(&mut evidence, referenced_evidence(project, analyses, reference)?); }
            for command in &operations {
                if let Some(candidate) = command_evidence(project, command) { push_unique_evidence(&mut evidence, candidate); }
            }
            let proposal = EditProposal {
                id: format!("proposal-{}", Uuid::new_v4()), base_revision: project.revision, summary: summary.clone(), rationale,
                confidence, operations, evidence, created_at: now_millis(),
            };
            Ok(AgentResponse { message: summary, proposal: Some(proposal), question: None, analysis_request: None })
        }
        "ask_user_question" => {
            let tool_args: AgentQuestionArgs = serde_json::from_value(args.clone()).map_err(|error| AppError::new("GEMINI_SCHEMA", error.to_string()).with_details(args.clone()))?;
            let text = tool_args.question.trim().to_string();
            if text.is_empty() { return Err(AppError::new("AGENT_QUESTION", "O Gemini retornou uma pergunta vazia")); }
            if text.chars().count() > 500 { return Err(AppError::new("AGENT_QUESTION", "A pergunta do Gemini excedeu 500 caracteres")); }
            let context = tool_args.context.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
            if context.as_ref().is_some_and(|value| value.chars().count() > 300) { return Err(AppError::new("AGENT_QUESTION", "O contexto da pergunta excedeu 300 caracteres")); }
            let raw_options = tool_args.options.unwrap_or_default();
            if raw_options.len() > 5 { return Err(AppError::new("AGENT_QUESTION", "A pergunta do Gemini excedeu 5 opções")); }
            let mut options = Vec::new();
            for raw_option in raw_options {
                let option = raw_option.trim();
                if option.is_empty() { continue; }
                if option.chars().count() > 120 { return Err(AppError::new("AGENT_QUESTION", "Uma opção da pergunta excedeu 120 caracteres")); }
                if !options.iter().any(|existing: &String| existing.eq_ignore_ascii_case(option)) { options.push(option.to_string()); }
            }
            let question = AgentQuestion { text: text.clone(), context, options };
            Ok(AgentResponse { message: text, proposal: None, question: Some(question), analysis_request: None })
        }
        "request_visual_analysis" => {
            let tool_args: AgentAnalysisArgs = serde_json::from_value(args.clone()).map_err(|error| AppError::new("GEMINI_SCHEMA", error.to_string()).with_details(args.clone()))?;
            let asset_id = tool_args.asset_id.or_else(|| selection.asset_id.clone()).or_else(|| {
                let videos = project.assets.iter().filter(|asset| asset.width.is_some() && asset.height.is_some() && !asset.offline).collect::<Vec<_>>();
                (videos.len() == 1).then(|| videos[0].id.clone())
            }).ok_or_else(|| AppError::new("AGENT_ANALYSIS_TARGET", "Selecione a mídia que deve receber análise visual"))?;
            let asset = project.assets.iter().find(|asset| asset.id == asset_id && asset.width.is_some() && asset.height.is_some() && !asset.offline)
                .ok_or_else(|| AppError::new("AGENT_ANALYSIS_TARGET", "A mídia indicada não está disponível para análise visual"))?;
            if asset.path.is_none() { return Err(AppError::new("AGENT_ANALYSIS_TARGET", "A análise visual requer uma mídia local")); }
            let mut prompts = Vec::new();
            for prompt in tool_args.prompts {
                let prompt = prompt.trim().chars().take(48).collect::<String>();
                if !prompt.is_empty() && !prompts.iter().any(|existing: &String| existing.to_lowercase() == prompt.to_lowercase()) { prompts.push(prompt); }
                if prompts.len() == 24 { break; }
            }
            if prompts.is_empty() { return Err(AppError::new("AGENT_ANALYSIS_PROMPTS", "A análise direcionada requer ao menos uma categoria visual")); }
            let reason = bounded_text(tool_args.reason, "A edição depende de contexto visual mais específico.", 500);
            Ok(AgentResponse {
                message: format!("Análise visual direcionada solicitada para {}.", asset.name), proposal: None, question: None,
                analysis_request: Some(AgentAnalysisRequest { asset_id, prompts, reason }),
            })
        }
        other => Err(AppError::new("GEMINI_TOOL_CALL", format!("Gemini chamou uma função não permitida: {other}"))),
    }
}

#[cfg(test)]
fn plan_from_function_call(project: &EditorProject, name: &str, args: &Value) -> Result<AgentResponse, AppError> {
    plan_from_function_call_with_selection(project, &AgentSelection::default(), &[], name, args)
}

#[tauri::command]
pub fn gemini_key_set(api_key: String, state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() { return Err(AppError::new("EMPTY_API_KEY", "A chave Gemini está vazia")); }
    *state.gemini_key.lock().map_err(|_| AppError::new("STATE_POISONED", "Configuração indisponível"))? = Some(trimmed.to_string());
    Ok(())
}

#[tauri::command]
pub fn gemini_key_clear(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    *state.gemini_key.lock().map_err(|_| AppError::new("STATE_POISONED", "Configuração indisponível"))? = None;
    Ok(())
}

#[tauri::command]
pub async fn agent_plan(
    prompt: String,
    project: EditorProject,
    history: Vec<AgentChatTurn>,
    selection: Option<AgentSelection>,
    state: tauri::State<'_, AppState>,
    analysis_state: tauri::State<'_, AnalysisState>,
) -> Result<AgentResponse, AppError> {
    let selection = selection.unwrap_or_default();
    let planning_revision = project.revision;
    let current_revision = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.revision;
    if current_revision != planning_revision { return Err(AppError::retryable("STALE_AGENT_CONTEXT", "A timeline mudou antes do planejamento; envie o pedido novamente")); }
    let api_key = state.gemini_key.lock().map_err(|_| AppError::new("STATE_POISONED", "Configuração indisponível"))?.clone()
        .or_else(|| std::env::var("GEMINI_API_KEY").ok())
        .ok_or_else(|| AppError::new("GEMINI_KEY_MISSING", "Configure uma chave Gemini para esta sessão"))?;
    let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-3.5-flash".into());
    let analyses = analysis_state.records_for_assets(project.assets.iter().map(|asset| asset.id.as_str()))?;
    let mut contents = history.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().map(|turn| json!({
        "role": if turn.role == "assistant" { "model" } else { "user" },
        "parts": [{"text": turn.text.chars().take(4_000).collect::<String>()}],
    })).collect::<Vec<_>>();
    contents.push(json!({"role": "user", "parts": [{"text": format!("Pedido atual:\n{}\n\nContexto local estruturado (sem caminhos de arquivos nem mídia bruta):\n{}", prompt, compact_context(&project, &selection, &analyses, &prompt))}]}));
    let request = json!({
        "systemInstruction": {"parts": [{"text": "Você é o diretor e editor autônomo de um editor de vídeo não destrutivo. Decida ritmo, foco e estilo usando timeline, seleção, transcrição com tempos e, quando disponível, cenas, objetos e OCR gerados localmente. Você não recebe a mídia bruta; visualAnalysis é a fonte visual verificável. Pedidos de layout, cor, tipografia, legenda, proporção, cortes e efeitos não exigem pixels brutos. Não invente IDs. trackId e clipId podem ser omitidos quando há um único alvo ou seleção inequívoca; o editor os resolve. Para remover pausas, use removeSilences. Para 9:16, 16:9, 1:1 ou 4:5 use setCanvas. createCaptions cria legendas e setCaptionStyle altera sua aparência. insertAsset insere uma mídia complementar já importada e cria uma faixa compatível se necessário. focusObservation cria reenquadramento animado para um observationId real; animateTransform cria movimento deliberado. Se uma decisão realmente depender de objetos que não existem em visualAnalysis, use request_visual_analysis uma única vez com categorias textuais específicas; não use essa ferramenta para estilos ou operações que já são possíveis. Retorne exatamente uma chamada de função por turno. Use ask_user_question somente quando faltar uma decisão que mudaria materialmente o resultado e não houver preferência anterior no histórico. Quando houver contexto suficiente, use propose_edit_operations com operações reais, justificativa, confiança e evidências. A chamada cria somente uma proposta revisável: nunca afirme que a timeline já foi alterada. Nunca pergunte e proponha no mesmo turno. Prefira decisões coerentes em toda a sequência e cite IDs de cena/observação quando a decisão depender do conteúdo visual."}]},
        "contents": contents,
        "tools": [{"functionDeclarations": [
            {
                "name": "propose_edit_operations",
                "description": "Cria uma proposta de edição validada para revisão do usuário; não altera a timeline",
                "parameters": {
                    "type": "OBJECT",
                    "required": ["message", "rationale", "confidence", "evidence", "operations"],
                    "properties": {
                        "message": {"type": "STRING", "description": "Resumo curto e factual do que será alterado"},
                        "rationale": {"type": "STRING", "description": "Justificativa editorial objetiva baseada no conteúdo e no pedido"},
                        "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                        "evidence": {"type": "ARRAY", "description": "Até 24 trechos verificáveis que justificam a proposta", "items": {"type": "OBJECT", "properties": {
                            "kind": {"type": "STRING", "enum": ["timeline", "transcript", "scene", "object", "ocr"]},
                            "label": {"type": "STRING"}, "assetId": {"type": "STRING"}, "sceneId": {"type": "STRING"}, "observationId": {"type": "STRING"},
                            "startTick": {"type": "INTEGER"}, "endTick": {"type": "INTEGER"}
                        }}},
                        "operations": {"type": "ARRAY", "items": {"type": "OBJECT", "required": ["kind"], "properties": {
                            "kind": {"type": "STRING", "description": "Operação de intenção ou edição. Use operações de intenção para tarefas complexas.", "enum": ["insertAsset", "deleteClip", "moveClip", "trimClip", "splitClip", "setVolume", "setSpeed", "setOpacity", "setTransform", "animateTransform", "focusObservation", "addEffect", "setTransition", "createCaptions", "setCaptionStyle", "setCaptionText", "clearCaptions", "setCanvas", "removeSilences"]},
                            "trackId": {"type": "STRING", "description": "Opcional se a seleção, clipId ou um único clipe resolverem a faixa"}, "clipId": {"type": "STRING", "description": "Opcional quando existe um único clipe-alvo inequívoco"}, "assetId": {"type": "STRING", "description": "Asset alvo; útil para captions ou para resolver o clipe"},
                            "startTick": {"type": "INTEGER"}, "sourceInTick": {"type": "INTEGER"}, "durationTicks": {"type": "INTEGER"}, "atTick": {"type": "INTEGER"},
                            "ripple": {"type": "BOOLEAN"}, "value": {"type": "NUMBER"},
                            "effectKind": {"type": "STRING", "enum": ["exposure", "contrast", "saturation", "temperature", "chromaKey", "blur"]},
                            "edge": {"type": "STRING", "enum": ["in", "out"]},
                            "transitionKind": {"type": "STRING", "enum": ["crossDissolve", "dipToBlack", "slide", "audioCrossfade"]},
                            "x": {"type": "NUMBER"}, "y": {"type": "NUMBER"}, "scale": {"type": "NUMBER"}, "rotation": {"type": "NUMBER"},
                            "endX": {"type": "NUMBER"}, "endY": {"type": "NUMBER"}, "endScale": {"type": "NUMBER"}, "endRotation": {"type": "NUMBER"},
                            "easing": {"type": "STRING", "enum": ["linear", "easeIn", "easeOut", "easeInOut"]},
                            "observationId": {"type": "STRING", "description": "ID real de visualAnalysis para focusObservation"},
                            "cropTop": {"type": "NUMBER", "description": "Crop normalizado de 0 a 0.49"}, "cropRight": {"type": "NUMBER"}, "cropBottom": {"type": "NUMBER"}, "cropLeft": {"type": "NUMBER"},
                            "aspectRatio": {"type": "STRING", "enum": ["9:16", "16:9", "1:1", "4:5"]},
                            "fitMode": {"type": "STRING", "description": "cover preenche o quadro; contain evita crop", "enum": ["cover", "contain"]},
                            "fontFamily": {"type": "STRING", "enum": ["modern", "mono", "serif"]}, "fontSize": {"type": "INTEGER"},
                            "textColor": {"type": "STRING", "description": "Cor hexadecimal #RRGGBB"}, "background": {"type": "BOOLEAN"}, "backgroundColor": {"type": "STRING"},
                            "uppercase": {"type": "BOOLEAN"}, "bold": {"type": "BOOLEAN"}, "position": {"type": "STRING", "enum": ["top", "center", "bottom"]},
                            "minSilenceTicks": {"type": "INTEGER", "description": "Pausa mínima removível; timebase do projeto normalmente 240000 ticks/s"}, "paddingTicks": {"type": "INTEGER", "description": "Respiro preservado ao redor da fala"},
                            "captionId": {"type": "STRING"}, "text": {"type": "STRING"}
                        }} }
                    }
                }
            },
            {
                "name": "request_visual_analysis",
                "description": "Solicita uma análise local direcionada quando faltam categorias visuais indispensáveis para planejar a edição",
                "parameters": {
                    "type": "OBJECT",
                    "required": ["prompts", "reason"],
                    "properties": {
                        "assetId": {"type": "STRING", "description": "Opcional quando a seleção ou uma única mídia resolve o alvo"},
                        "prompts": {"type": "ARRAY", "description": "Categorias visuais concretas para YOLO-World", "items": {"type": "STRING"}},
                        "reason": {"type": "STRING", "description": "Por que essa análise é necessária para a decisão editorial"}
                    }
                }
            },
            {
                "name": "ask_user_question",
                "description": "Pede uma única decisão ao usuário quando a resposta mudaria materialmente a edição. Não altera a timeline.",
                "parameters": {
                    "type": "OBJECT",
                    "required": ["question"],
                    "properties": {
                        "question": {"type": "STRING", "description": "Pergunta curta e específica, escrita no idioma do usuário"},
                        "context": {"type": "STRING", "description": "Explicação opcional e breve de por que essa decisão é necessária"},
                        "options": {"type": "ARRAY", "description": "Até cinco respostas curtas e mutuamente distintas; omita quando a resposta for livre", "items": {"type": "STRING"}}
                    }
                }
            }
        ]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["propose_edit_operations", "request_visual_analysis", "ask_user_question"]}}
    });
    let endpoint = format!("https://generativelanguage.googleapis.com/v1/models/{model}:generateContent");
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(90)).build()
        .map_err(|error| AppError::new("GEMINI_CLIENT", error.to_string()))?;
    let mut attempt = 0_u32;
    let body = loop {
        match client.post(&endpoint).header("x-goog-api-key", &api_key).json(&request).send().await {
            Ok(response) => {
                let status = response.status();
                let parsed = response.json::<Value>().await;
                if status.is_success() {
                    break parsed.map_err(|error| AppError::new("GEMINI_RESPONSE", error.to_string()))?;
                }
                let body = parsed.unwrap_or_else(|_| json!({}));
                if retryable_gemini_status(status) && attempt < 3 {
                    tokio::time::sleep(gemini_retry_delay(attempt)).await;
                    attempt += 1;
                    continue;
                }
                let message = body.pointer("/error/message").and_then(Value::as_str).unwrap_or("Gemini rejeitou a solicitação");
                return Err(AppError::retryable("GEMINI_API", message));
            }
            Err(error) => {
                if attempt < 3 && (error.is_timeout() || error.is_connect()) {
                    tokio::time::sleep(gemini_retry_delay(attempt)).await;
                    attempt += 1;
                    continue;
                }
                return Err(AppError::retryable("GEMINI_NETWORK", error.to_string()));
            }
        }
    };
    let function_calls = body.pointer("/candidates/0/content/parts").and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(|part| part.get("functionCall")).collect::<Vec<_>>())
        .ok_or_else(|| AppError::new("GEMINI_TOOL_CALL", "Gemini não retornou uma chamada de função"))?;
    if function_calls.len() != 1 { return Err(AppError::new("GEMINI_TOOL_CALL", "Gemini deve retornar exatamente uma chamada de função")); }
    let function_call = function_calls[0];
    let function_name = function_call.get("name").and_then(Value::as_str).ok_or_else(|| AppError::new("GEMINI_TOOL_CALL", "A chamada do Gemini não informou a função"))?;
    let args = function_call.get("args").ok_or_else(|| AppError::new("GEMINI_TOOL_CALL", "A chamada do Gemini não informou argumentos"))?;
    let plan = plan_from_function_call_with_selection(&project, &selection, &analyses, function_name, args)?;
    let current_revision = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.revision;
    if current_revision != planning_revision { return Err(AppError::retryable("STALE_AGENT_CONTEXT", "A timeline mudou durante o planejamento; nenhuma operação foi aplicada")); }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{EditorProject, MediaAsset, Transcript, TranscriptSegment, Transform};

    fn project_with_video(duration_ticks: i64) -> EditorProject {
        let mut project = EditorProject::empty("Test");
        project.assets.push(MediaAsset { id: "asset".into(), name: "clip.mp4".into(), path: None, object_url: None, duration_ticks, width: Some(1920), height: Some(1080), fps: Some(30.0), codec: Some("h264".into()), has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false });
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "asset".into(), name: "Clip".into(), start_tick: 0, source_in_tick: 0, duration_ticks, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: vec![], effects: vec![], transition_in: None, transition_out: None });
        project
    }

    #[test]
    fn context_redacts_file_paths() {
        let mut project = EditorProject::empty("Test");
        project.assets.push(crate::domain::MediaAsset { id: "asset".into(), name: "clip.mp4".into(), path: Some("/secret/path.mp4".into()), object_url: None, duration_ticks: 10, width: None, height: None, fps: None, codec: None, has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false });
        let encoded = compact_context(&project, &AgentSelection::default(), &[], "").to_string();
        assert!(!encoded.contains("/secret"));
    }

    #[test]
    fn rejects_nonexistent_agent_target() {
        let project = EditorProject::empty("Test");
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "deleteClip", "trackId": "missing", "clipId": "missing" })).unwrap();
        assert!(operation_to_command(&project, operation).is_err());
        let _ = TimelineClip { id: String::new(), asset_id: String::new(), name: String::new(), start_tick: 0, source_in_tick: 0, duration_ticks: 1, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: vec![], effects: vec![], transition_in: None, transition_out: None };
    }

    #[test]
    fn maps_scalar_operations_to_real_patch_keys() {
        let mut project = EditorProject::empty("Test");
        let track_id = project.active_sequence().unwrap().tracks[0].id.clone();
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "asset".into(), name: "Clip".into(), start_tick: 0, source_in_tick: 0, duration_ticks: 10, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: vec![], effects: vec![], transition_in: None, transition_out: None });
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "setVolume", "trackId": track_id, "clipId": "clip", "value": 0.25 })).unwrap();
        let EditCommand::UpdateClip { patch, .. } = operation_to_command(&project, operation).unwrap() else { panic!("operação inesperada") };
        assert_eq!(patch.get("volume").and_then(Value::as_f64), Some(0.25));
        assert!(patch.get("key").is_none());
    }

    #[test]
    fn infers_the_only_clip_track_when_ids_are_omitted() {
        let mut project = EditorProject::empty("Test");
        let track_id = project.active_sequence().unwrap().tracks[0].id.clone();
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "asset".into(), name: "Clip".into(), start_tick: 0, source_in_tick: 0, duration_ticks: 10, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: vec![], effects: vec![], transition_in: None, transition_out: None });
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "splitClip", "atTick": 5 })).unwrap();
        let EditCommand::SplitClip { track_id: resolved_track, clip_id, .. } = operation_to_command(&project, operation).unwrap() else { panic!("operação inesperada") };
        assert_eq!(resolved_track, track_id);
        assert_eq!(clip_id, "clip");
    }

    #[test]
    fn canvas_operation_builds_vertical_settings_and_cover_transform() {
        let project = project_with_video(2_400_000);
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "setCanvas", "aspectRatio": "9:16", "fitMode": "cover" })).unwrap();
        let commands = operation_to_commands(&project, &AgentSelection::default(), &[], operation).unwrap();
        assert!(matches!(&commands[0], EditCommand::SetProjectSettings { settings } if settings.width == 1080 && settings.height == 1920));
        let EditCommand::UpdateClip { patch, .. } = &commands[1] else { panic!("transform esperado") };
        assert!(patch.pointer("/transform/scale").and_then(Value::as_f64).is_some_and(|scale| scale > 3.0));
    }

    #[test]
    fn caption_style_updates_only_requested_properties() {
        let project = EditorProject::empty("Test");
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "setCaptionStyle", "textColor": "#ffff00", "background": false, "fontFamily": "modern", "uppercase": true })).unwrap();
        let commands = operation_to_commands(&project, &AgentSelection::default(), &[], operation).unwrap();
        let EditCommand::SetCaptionStyle { style, .. } = &commands[0] else { panic!("estilo esperado") };
        assert_eq!(style.text_color, "#FFFF00");
        assert!(!style.background);
        assert!(style.uppercase);
        assert_eq!(style.position, "bottom");
    }

    #[test]
    fn remove_silences_rebuilds_the_only_clip_without_track_ids() {
        let mut project = project_with_video(2_400_000);
        project.transcripts.push(Transcript {
            asset_id: "asset".into(), engine: "test".into(), model: "test".into(), source_fingerprint: None, language: Some("pt".into()),
            segments: vec![
                TranscriptSegment { id: "one".into(), start_tick: 0, end_tick: 240_000, text: "Um".into(), language: None, speaker: None, words: None, confidence: None },
                TranscriptSegment { id: "two".into(), start_tick: 960_000, end_tick: 1_200_000, text: "Dois".into(), language: None, speaker: None, words: None, confidence: None },
                TranscriptSegment { id: "three".into(), start_tick: 2_160_000, end_tick: 2_400_000, text: "Três".into(), language: None, speaker: None, words: None, confidence: None },
            ],
        });
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "removeSilences", "minSilenceTicks": 240000, "paddingTicks": 24000 })).unwrap();
        let commands = operation_to_commands(&project, &AgentSelection::default(), &[], operation).unwrap();
        for command in commands { apply_command(&mut project, command).unwrap(); }
        let clips = &project.active_sequence().unwrap().tracks[0].clips;
        assert!(clips.len() >= 3);
        assert!(clips.iter().map(|clip| clip.duration_ticks).sum::<i64>() < 1_200_000);
    }

    #[test]
    fn composes_silence_removal_and_vertical_canvas_on_projected_state() {
        let mut project = project_with_video(2_400_000);
        project.transcripts.push(Transcript {
            asset_id: "asset".into(), engine: "test".into(), model: "test".into(), source_fingerprint: None, language: Some("pt".into()),
            segments: vec![
                TranscriptSegment { id: "one".into(), start_tick: 0, end_tick: 240_000, text: "Um".into(), language: None, speaker: None, words: None, confidence: None },
                TranscriptSegment { id: "two".into(), start_tick: 960_000, end_tick: 1_200_000, text: "Dois".into(), language: None, speaker: None, words: None, confidence: None },
            ],
        });
        let plan = plan_from_function_call(&project, "propose_edit_operations", &json!({
            "message": "Criando vídeo curto vertical",
            "operations": [
                { "kind": "removeSilences", "minSilenceTicks": 240000 },
                { "kind": "setCanvas", "aspectRatio": "9:16", "fitMode": "cover" }
            ]
        })).unwrap();
        for command in plan.proposal.unwrap().operations { apply_command(&mut project, command).unwrap(); }
        assert_eq!((project.settings.width, project.settings.height), (1080, 1920));
        assert!(project.active_sequence().unwrap().tracks[0].clips.iter().all(|clip| clip.transform.scale > 3.0));
    }

    #[test]
    fn retries_only_transient_gemini_statuses() {
        assert!(retryable_gemini_status(reqwest::StatusCode::TOO_MANY_REQUESTS));
        assert!(retryable_gemini_status(reqwest::StatusCode::SERVICE_UNAVAILABLE));
        assert!(!retryable_gemini_status(reqwest::StatusCode::BAD_REQUEST));
    }

    #[test]
    fn question_tool_returns_no_edit_operations() {
        let project = EditorProject::empty("Test");
        let plan = plan_from_function_call(&project, "ask_user_question", &json!({ "question": "  Qual ritmo você prefere?  ", "context": "  Isso define a duração dos cortes.  ", "options": ["Dinâmico", "Contemplativo", "dinâmico", ""] })).unwrap();
        assert!(plan.proposal.is_none());
        let question = plan.question.expect("pergunta estruturada");
        assert_eq!(question.text, "Qual ritmo você prefere?");
        assert_eq!(question.context.as_deref(), Some("Isso define a duração dos cortes."));
        assert_eq!(question.options, vec!["Dinâmico", "Contemplativo"]);
    }

    #[test]
    fn question_tool_rejects_empty_questions() {
        let project = EditorProject::empty("Test");
        let error = plan_from_function_call(&project, "ask_user_question", &json!({ "question": "   " })).unwrap_err();
        assert_eq!(error.code, "AGENT_QUESTION");
    }

    #[test]
    fn directed_analysis_request_resolves_the_only_local_video() {
        let mut project = project_with_video(240_000);
        project.assets[0].path = Some("/tmp/video.mp4".into());
        let response = plan_from_function_call_with_selection(
            &project,
            &AgentSelection::default(),
            &[],
            "request_visual_analysis",
            &json!({ "prompts": ["gráfico", "produto", "GRÁFICO"], "reason": "Identificar o elemento citado" }),
        ).unwrap();
        let request = response.analysis_request.expect("solicitação estruturada");
        assert_eq!(request.asset_id, "asset");
        assert_eq!(request.prompts, vec!["gráfico", "produto"]);
        assert!(response.proposal.is_none());
    }

    #[test]
    fn focus_observation_generates_valid_transform_keyframes() {
        let project = project_with_video(1_200_000);
        let observation = VisualObservation {
            id: "phone".into(), kind: "object".into(), label: "phone".into(), text: None, confidence: 0.9,
            rect: crate::analysis::NormalizedRect { x: 0.7, y: 0.2, width: 0.15, height: 0.3 },
            start_tick: 240_000, end_tick: 720_000, track_id: Some("visual-track".into()),
        };
        let analysis = AssetAnalysis {
            schema_version: 1, asset_id: "asset".into(), source_fingerprint: "fingerprint".into(), pipeline_version: "local-v1".into(),
            stages: Vec::new(), scenes: vec![SceneAnalysis {
                id: "scene".into(), start_tick: 240_000, end_tick: 720_000, representative_tick: 480_000,
                motion_score: 0.4, thumbnail_path: None, observations: vec![observation],
            }], updated_at: 0,
        };
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "focusObservation", "observationId": "phone" })).unwrap();
        let commands = operation_to_commands(&project, &AgentSelection::default(), &[analysis], operation).unwrap();
        let EditCommand::UpdateClip { patch, .. } = &commands[0] else { panic!("keyframes esperados") };
        let keyframes = patch.get("keyframes").and_then(Value::as_array).unwrap();
        assert!(keyframes.len() >= 3);
        assert!(keyframes.iter().any(|keyframe| keyframe.pointer("/value/scale").and_then(Value::as_f64).is_some_and(|scale| scale > 1.0)));
    }

    #[test]
    fn insert_asset_creates_a_compatible_track_when_needed() {
        let mut project = EditorProject::empty("Test");
        project.active_sequence_mut().unwrap().tracks.retain(|track| track.kind == "video");
        project.assets.push(MediaAsset {
            id: "music".into(), name: "music.wav".into(), path: Some("/tmp/music.wav".into()), object_url: None,
            duration_ticks: 480_000, width: None, height: None, fps: None, codec: Some("pcm".into()), has_audio: true,
            fingerprint: None, proxy_path: None, waveform: None, offline: false,
        });
        let operation: AgentOperation = serde_json::from_value(json!({ "kind": "insertAsset", "assetId": "music", "startTick": 120000, "durationTicks": 240000 })).unwrap();
        let commands = operation_to_commands(&project, &AgentSelection::default(), &[], operation).unwrap();
        assert!(matches!(&commands[0], EditCommand::AddTrack { track, .. } if track.kind == "audio"));
        assert!(matches!(&commands[1], EditCommand::InsertClip { clip, .. } if clip.start_tick == 120_000 && clip.duration_ticks == 240_000));
    }
}
