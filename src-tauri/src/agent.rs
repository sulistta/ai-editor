use crate::{
    domain::{AppState, CaptionCue, EditCommand, EditorProject, EffectInstance},
    error::AppError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiPlan {
    pub message: String,
    pub operations: Vec<EditCommand>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AgentChatTurn {
    role: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolArgs {
    message: Option<String>,
    operations: Vec<AgentOperation>,
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
}

fn compact_context(project: &EditorProject) -> Value {
    let assets = project.assets.iter().map(|asset| json!({
        "id": asset.id,
        "name": asset.name,
        "durationTicks": asset.duration_ticks,
        "hasAudio": asset.has_audio,
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
            "clips": track.clips.iter().map(|clip| json!({
                "id": clip.id,
                "assetId": clip.asset_id,
                "name": clip.name,
                "startTick": clip.start_tick,
                "sourceInTick": clip.source_in_tick,
                "durationTicks": clip.duration_ticks,
                "speed": clip.speed,
                "volume": clip.volume,
                "effects": clip.effects,
                "transitionIn": clip.transition_in,
                "transitionOut": clip.transition_out,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "captions": sequence.captions,
        "markers": sequence.markers,
    }));
    let transcripts = project.transcripts.iter().map(|transcript| json!({
        "assetId": transcript.asset_id,
        "language": transcript.language,
        "segments": transcript.segments.iter().take(2500).map(|segment| json!({
            "startTick": segment.start_tick,
            "endTick": segment.end_tick,
            "text": segment.text,
        })).collect::<Vec<_>>(),
    })).collect::<Vec<_>>();
    json!({
        "timebase": project.settings.timebase,
        "revision": project.revision,
        "assets": assets,
        "sequence": sequence,
        "transcripts": transcripts,
    })
}

fn clip_exists(project: &EditorProject, track_id: &str, clip_id: &str) -> bool {
    project.active_sequence().is_some_and(|sequence| sequence.tracks.iter().any(|track| track.id == track_id && track.clips.iter().any(|clip| clip.id == clip_id)))
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

fn operation_to_command(project: &EditorProject, operation: AgentOperation) -> Result<EditCommand, AppError> {
    match operation.kind.as_str() {
        "deleteClip" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "deleteClip requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "deleteClip requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            Ok(EditCommand::DeleteClip { track_id, clip_id, ripple: operation.ripple.unwrap_or(false) })
        }
        "moveClip" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "moveClip requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "moveClip requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            Ok(EditCommand::MoveClip { track_id, clip_id, start_tick: operation.start_tick.unwrap_or_default().max(0) })
        }
        "trimClip" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "trimClip requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "trimClip requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            Ok(EditCommand::TrimClip {
                track_id,
                clip_id,
                source_in_tick: operation.source_in_tick.unwrap_or_default().max(0),
                duration_ticks: operation.duration_ticks.unwrap_or(1).max(1),
            })
        }
        "splitClip" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "splitClip requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "splitClip requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            Ok(EditCommand::SplitClip { track_id, clip_id, at_tick: operation.at_tick.unwrap_or_default(), right_clip_id: format!("clip-{}", Uuid::new_v4()) })
        }
        "setVolume" | "setSpeed" | "setOpacity" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "A operação requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "A operação requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
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
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransform requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransform requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            let clip = project.active_sequence().unwrap().tracks.iter().find(|track| track.id == track_id).and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).unwrap();
            let mut transform = clip.transform.clone();
            if let Some(value) = operation.x { transform.x = value.clamp(-(project.settings.width as f64), project.settings.width as f64); }
            if let Some(value) = operation.y { transform.y = value.clamp(-(project.settings.height as f64), project.settings.height as f64); }
            if let Some(value) = operation.scale { transform.scale = value.clamp(0.01, 10.0); }
            if let Some(value) = operation.rotation { transform.rotation = value.clamp(-360.0, 360.0); }
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"transform": transform}) })
        }
        "addEffect" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "addEffect requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "addEffect requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            let effect_kind = operation.effect_kind.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "addEffect requer effectKind"))?;
            if !matches!(effect_kind.as_str(), "exposure" | "contrast" | "saturation" | "temperature" | "chromaKey" | "blur") { return Err(AppError::new("AGENT_EFFECT", "Efeito não permitido")); }
            let clip = project.active_sequence().unwrap().tracks.iter().find(|track| track.id == track_id).and_then(|track| track.clips.iter().find(|clip| clip.id == clip_id)).unwrap();
            let mut effects = clip.effects.clone();
            effects.push(EffectInstance { id: format!("effect-{}", Uuid::new_v4()), kind: effect_kind, enabled: true, value: operation.value.unwrap_or(0.0).clamp(-1.0, 1.0) });
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch: json!({"effects": effects}) })
        }
        "setTransition" => {
            let track_id = operation.track_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransition requer trackId"))?;
            let clip_id = operation.clip_id.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransition requer clipId"))?;
            if !clip_exists(project, &track_id, &clip_id) { return Err(AppError::new("AGENT_TARGET", "O agente referenciou um clipe inexistente")); }
            let transition_kind = operation.transition_kind.ok_or_else(|| AppError::new("AGENT_ARGUMENT", "setTransition requer transitionKind"))?;
            if !matches!(transition_kind.as_str(), "crossDissolve" | "dipToBlack" | "slide" | "audioCrossfade") { return Err(AppError::new("AGENT_TRANSITION", "Transição não permitida")); }
            let duration_ticks = operation.duration_ticks.unwrap_or(120_000).clamp(1, 720_000);
            let transition = json!({"kind": transition_kind, "durationTicks": duration_ticks});
            let patch = match operation.edge.as_deref() {
                Some("out") => json!({"transitionOut": transition}),
                Some("in") => json!({"transitionIn": transition}),
                _ => return Err(AppError::new("AGENT_ARGUMENT", "setTransition requer edge in ou out")),
            };
            Ok(EditCommand::UpdateClip { track_id, clip_id, patch })
        }
        "createCaptions" => {
            let asset_id = operation.asset_id.or_else(|| project.transcripts.first().map(|transcript| transcript.asset_id.clone())).ok_or_else(|| AppError::new("TRANSCRIPT_REQUIRED", "Não existe transcrição para criar legendas"))?;
            let captions = captions_from_transcript(project, &asset_id)?;
            Ok(EditCommand::SetCaptions { sequence_id: project.active_sequence_id.clone(), captions })
        }
        other => Err(AppError::new("AGENT_OPERATION", format!("Operação não permitida: {other}"))),
    }
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
pub async fn agent_plan(prompt: String, project: EditorProject, history: Vec<AgentChatTurn>, state: tauri::State<'_, AppState>) -> Result<GeminiPlan, AppError> {
    let planning_revision = project.revision;
    let current_revision = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.revision;
    if current_revision != planning_revision { return Err(AppError::retryable("STALE_AGENT_CONTEXT", "A timeline mudou antes do planejamento; envie o pedido novamente")); }
    let lower = prompt.to_lowercase();
    if ["rosto", "olhar", "imagem", "enquadramento", "objeto", "aparece"].iter().any(|term| lower.contains(term)) {
        return Err(AppError::new("VISUAL_CONTEXT_REQUIRED", "O pedido depende de análise visual, desabilitada neste produto"));
    }
    let api_key = state.gemini_key.lock().map_err(|_| AppError::new("STATE_POISONED", "Configuração indisponível"))?.clone()
        .or_else(|| std::env::var("GEMINI_API_KEY").ok())
        .ok_or_else(|| AppError::new("GEMINI_KEY_MISSING", "Configure uma chave Gemini para esta sessão"))?;
    let model = std::env::var("GEMINI_MODEL").unwrap_or_else(|_| "gemini-3.5-flash".into());
    let mut contents = history.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().map(|turn| json!({
        "role": if turn.role == "assistant" { "model" } else { "user" },
        "parts": [{"text": turn.text.chars().take(4_000).collect::<String>()}],
    })).collect::<Vec<_>>();
    contents.push(json!({"role": "user", "parts": [{"text": format!("Pedido atual:\n{}\n\nProjeto e transcript atuais:\n{}", prompt, compact_context(&project))}]}));
    let request = json!({
        "systemInstruction": {"parts": [{"text": "Você é o agente de um editor de vídeo não destrutivo. Use somente os IDs e ticks fornecidos. O áudio e o vídeo não estão disponíveis. Não invente clipes. Retorne uma única chamada apply_edit_operations. Prefira alterações mínimas e reversíveis."}]},
        "contents": contents,
        "tools": [{"functionDeclarations": [{
            "name": "apply_edit_operations",
            "description": "Aplica operações de edição validadas ao projeto atual",
            "parameters": {
                "type": "OBJECT",
                "required": ["message", "operations"],
                "properties": {
                    "message": {"type": "STRING", "description": "Resumo curto e factual do que será alterado"},
                    "operations": {"type": "ARRAY", "items": {"type": "OBJECT", "required": ["kind"], "properties": {
                        "kind": {"type": "STRING", "enum": ["deleteClip", "moveClip", "trimClip", "splitClip", "setVolume", "setSpeed", "setOpacity", "setTransform", "addEffect", "setTransition", "createCaptions"]},
                        "trackId": {"type": "STRING"}, "clipId": {"type": "STRING"}, "assetId": {"type": "STRING"},
                        "startTick": {"type": "INTEGER"}, "sourceInTick": {"type": "INTEGER"}, "durationTicks": {"type": "INTEGER"}, "atTick": {"type": "INTEGER"},
                        "ripple": {"type": "BOOLEAN"}, "value": {"type": "NUMBER"},
                        "effectKind": {"type": "STRING", "enum": ["exposure", "contrast", "saturation", "temperature", "chromaKey", "blur"]},
                        "edge": {"type": "STRING", "enum": ["in", "out"]},
                        "transitionKind": {"type": "STRING", "enum": ["crossDissolve", "dipToBlack", "slide", "audioCrossfade"]},
                        "x": {"type": "NUMBER"}, "y": {"type": "NUMBER"}, "scale": {"type": "NUMBER"}, "rotation": {"type": "NUMBER"}
                    }} }
                }
            }
        }]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": ["apply_edit_operations"]}}
    });
    let endpoint = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(90)).build()
        .map_err(|error| AppError::new("GEMINI_CLIENT", error.to_string()))?;
    let response = client.post(endpoint).header("x-goog-api-key", api_key).json(&request).send().await
        .map_err(|error| AppError::retryable("GEMINI_NETWORK", error.to_string()))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| AppError::new("GEMINI_RESPONSE", error.to_string()))?;
    if !status.is_success() {
        let message = body.pointer("/error/message").and_then(Value::as_str).unwrap_or("Gemini rejeitou a solicitação");
        return Err(AppError::retryable("GEMINI_API", message));
    }
    let args = body.pointer("/candidates/0/content/parts").and_then(Value::as_array)
        .and_then(|parts| parts.iter().find_map(|part| part.get("functionCall").and_then(|call| call.get("args"))))
        .ok_or_else(|| AppError::new("GEMINI_TOOL_CALL", "Gemini não retornou uma chamada de edição"))?;
    let tool_args: AgentToolArgs = serde_json::from_value(args.clone()).map_err(|error| AppError::new("GEMINI_SCHEMA", error.to_string()).with_details(args.clone()))?;
    if tool_args.operations.len() > 64 { return Err(AppError::new("AGENT_LIMIT", "O plano excedeu 64 operações")); }
    let operations = tool_args.operations.into_iter().map(|operation| operation_to_command(&project, operation)).collect::<Result<Vec<_>, _>>()?;
    let current_revision = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.revision;
    if current_revision != planning_revision { return Err(AppError::retryable("STALE_AGENT_CONTEXT", "A timeline mudou durante o planejamento; nenhuma operação foi aplicada")); }
    Ok(GeminiPlan { message: tool_args.message.unwrap_or_else(|| format!("{} operações preparadas.", operations.len())), operations })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{EditorProject, TimelineClip, Transform};

    #[test]
    fn context_redacts_file_paths() {
        let mut project = EditorProject::empty("Test");
        project.assets.push(crate::domain::MediaAsset { id: "asset".into(), name: "clip.mp4".into(), path: Some("/secret/path.mp4".into()), object_url: None, duration_ticks: 10, width: None, height: None, fps: None, codec: None, has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false });
        let encoded = compact_context(&project).to_string();
        assert!(!encoded.contains("/secret"));
    }

    #[test]
    fn rejects_nonexistent_agent_target() {
        let project = EditorProject::empty("Test");
        let operation = AgentOperation { kind: "deleteClip".into(), track_id: Some("missing".into()), clip_id: Some("missing".into()), asset_id: None, start_tick: None, source_in_tick: None, duration_ticks: None, at_tick: None, ripple: None, value: None, effect_kind: None, edge: None, transition_kind: None, x: None, y: None, scale: None, rotation: None };
        assert!(operation_to_command(&project, operation).is_err());
        let _ = TimelineClip { id: String::new(), asset_id: String::new(), name: String::new(), start_tick: 0, source_in_tick: 0, duration_ticks: 1, speed: 1.0, volume: 1.0, transform: Transform::default(), effects: vec![], transition_in: None, transition_out: None };
    }

    #[test]
    fn maps_scalar_operations_to_real_patch_keys() {
        let mut project = EditorProject::empty("Test");
        let track_id = project.active_sequence().unwrap().tracks[0].id.clone();
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "asset".into(), name: "Clip".into(), start_tick: 0, source_in_tick: 0, duration_ticks: 10, speed: 1.0, volume: 1.0, transform: Transform::default(), effects: vec![], transition_in: None, transition_out: None });
        let operation = AgentOperation { kind: "setVolume".into(), track_id: Some(track_id), clip_id: Some("clip".into()), asset_id: None, start_tick: None, source_in_tick: None, duration_ticks: None, at_tick: None, ripple: None, value: Some(0.25), effect_kind: None, edge: None, transition_kind: None, x: None, y: None, scale: None, rotation: None };
        let EditCommand::UpdateClip { patch, .. } = operation_to_command(&project, operation).unwrap() else { panic!("operação inesperada") };
        assert_eq!(patch.get("volume").and_then(Value::as_f64), Some(0.25));
        assert!(patch.get("key").is_none());
    }
}
