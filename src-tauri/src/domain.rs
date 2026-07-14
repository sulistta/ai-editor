use crate::{error::AppError, media::allow_asset_file};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, path::Path, sync::{atomic::AtomicBool, Mutex}};
use tauri::Manager;
use uuid::Uuid;

pub const TICKS_PER_SECOND: i64 = 240_000;

fn id(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub sample_rate: u32,
    pub timebase: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub object_url: Option<String>,
    pub duration_ticks: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub codec: Option<String>,
    pub has_audio: bool,
    pub fingerprint: Option<String>,
    pub proxy_path: Option<String>,
    #[serde(default)]
    pub waveform: Option<Vec<f32>>,
    pub offline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub opacity: f64,
    pub crop_top: f64,
    pub crop_right: f64,
    pub crop_bottom: f64,
    pub crop_left: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformKeyframe {
    pub id: String,
    pub offset_tick: i64,
    pub easing: String,
    pub value: Transform,
}

impl Default for Transform {
    fn default() -> Self {
        Self { x: 0.0, y: 0.0, scale: 1.0, rotation: 0.0, opacity: 1.0, crop_top: 0.0, crop_right: 0.0, crop_bottom: 0.0, crop_left: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectInstance {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransition {
    pub kind: String,
    pub duration_ticks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub name: String,
    pub start_tick: i64,
    pub source_in_tick: i64,
    pub duration_ticks: i64,
    pub speed: f64,
    pub volume: f64,
    pub transform: Transform,
    pub keyframes: Vec<TransformKeyframe>,
    pub effects: Vec<EffectInstance>,
    #[serde(default)]
    pub transition_in: Option<ClipTransition>,
    #[serde(default)]
    pub transition_out: Option<ClipTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTrack {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub locked: bool,
    pub muted: bool,
    pub hidden: bool,
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub tick: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCue {
    pub id: String,
    pub start_tick: i64,
    pub end_tick: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    pub font_family: String,
    pub font_size: u32,
    pub text_color: String,
    pub background: bool,
    pub background_color: String,
    pub uppercase: bool,
    pub bold: bool,
    pub position: String,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self {
            font_family: "modern".into(),
            font_size: 48,
            text_color: "#FFFFFF".into(),
            background: true,
            background_color: "#000000".into(),
            uppercase: false,
            bold: true,
            position: "bottom".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: String,
    pub name: String,
    pub tracks: Vec<TimelineTrack>,
    pub markers: Vec<Marker>,
    pub captions: Vec<CaptionCue>,
    #[serde(default)]
    pub caption_style: CaptionStyle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub text: String,
    pub start_tick: i64,
    pub end_tick: i64,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub start_tick: i64,
    pub end_tick: i64,
    pub text: String,
    pub language: Option<String>,
    pub speaker: Option<String>,
    pub words: Option<Vec<TranscriptWord>>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub asset_id: String,
    pub engine: String,
    pub model: String,
    pub source_fingerprint: Option<String>,
    pub language: Option<String>,
    pub segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorProject {
    pub schema_version: u32,
    pub project_id: String,
    pub name: String,
    pub revision: u64,
    pub settings: ProjectSettings,
    pub assets: Vec<MediaAsset>,
    pub sequences: Vec<Sequence>,
    pub active_sequence_id: String,
    pub transcripts: Vec<Transcript>,
}

impl EditorProject {
    pub fn empty(name: impl Into<String>) -> Self {
        let sequence_id = id("sequence");
        Self {
            schema_version: 2,
            project_id: id("project"),
            name: name.into(),
            revision: 0,
            settings: ProjectSettings { width: 1920, height: 1080, fps_num: 30, fps_den: 1, sample_rate: 48_000, timebase: TICKS_PER_SECOND },
            assets: Vec::new(),
            sequences: vec![Sequence {
                id: sequence_id.clone(),
                name: "Sequência 01".into(),
                tracks: vec![
                    TimelineTrack { id: id("track-video"), name: "V1".into(), kind: "video".into(), locked: false, muted: false, hidden: false, clips: Vec::new() },
                    TimelineTrack { id: id("track-audio"), name: "A1".into(), kind: "audio".into(), locked: false, muted: false, hidden: false, clips: Vec::new() },
                ],
                markers: Vec::new(),
                captions: Vec::new(),
                caption_style: CaptionStyle::default(),
            }],
            active_sequence_id: sequence_id,
            transcripts: Vec::new(),
        }
    }

    pub fn active_sequence_mut(&mut self) -> Option<&mut Sequence> {
        self.sequences.iter_mut().find(|sequence| sequence.id == self.active_sequence_id)
    }

    pub fn active_sequence(&self) -> Option<&Sequence> {
        self.sequences.iter().find(|sequence| sequence.id == self.active_sequence_id)
    }
}

fn valid_caption_style(style: &CaptionStyle) -> bool {
    let valid_color = |value: &str| value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit());
    matches!(style.font_family.as_str(), "modern" | "mono" | "serif")
        && (12..=160).contains(&style.font_size)
        && valid_color(&style.text_color)
        && valid_color(&style.background_color)
        && matches!(style.position.as_str(), "top" | "center" | "bottom")
}

fn valid_transform(transform: &Transform, settings: &ProjectSettings) -> bool {
    let finite = [transform.x, transform.y, transform.scale, transform.rotation, transform.opacity, transform.crop_top, transform.crop_right, transform.crop_bottom, transform.crop_left]
        .into_iter().all(f64::is_finite);
    finite
        && transform.x.abs() <= settings.width as f64 * 10.0
        && transform.y.abs() <= settings.height as f64 * 10.0
        && (0.01..=10.0).contains(&transform.scale)
        && (-360.0..=360.0).contains(&transform.rotation)
        && (0.0..=1.0).contains(&transform.opacity)
        && [transform.crop_top, transform.crop_right, transform.crop_bottom, transform.crop_left].into_iter().all(|value| (0.0..=0.49).contains(&value))
}

fn easing_progress(value: f64, easing: &str) -> f64 {
    let progress = value.clamp(0.0, 1.0);
    match easing {
        "easeIn" => progress * progress,
        "easeOut" => 1.0 - (1.0 - progress) * (1.0 - progress),
        "easeInOut" if progress < 0.5 => 2.0 * progress * progress,
        "easeInOut" => 1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0,
        _ => progress,
    }
}

fn interpolate_transform(from: &Transform, to: &Transform, progress: f64, easing: &str) -> Transform {
    let amount = easing_progress(progress, easing);
    let interpolate = |left: f64, right: f64| left + (right - left) * amount;
    Transform {
        x: interpolate(from.x, to.x), y: interpolate(from.y, to.y), scale: interpolate(from.scale, to.scale),
        rotation: interpolate(from.rotation, to.rotation), opacity: interpolate(from.opacity, to.opacity),
        crop_top: interpolate(from.crop_top, to.crop_top), crop_right: interpolate(from.crop_right, to.crop_right),
        crop_bottom: interpolate(from.crop_bottom, to.crop_bottom), crop_left: interpolate(from.crop_left, to.crop_left),
    }
}

pub(crate) fn transform_at_offset(clip: &TimelineClip, offset_tick: i64) -> Transform {
    let mut previous_tick = 0;
    let mut previous = clip.transform.clone();
    for keyframe in &clip.keyframes {
        if offset_tick <= keyframe.offset_tick {
            let span = keyframe.offset_tick - previous_tick;
            if span <= 0 { return keyframe.value.clone(); }
            return interpolate_transform(&previous, &keyframe.value, (offset_tick - previous_tick) as f64 / span as f64, &keyframe.easing);
        }
        previous_tick = keyframe.offset_tick;
        previous = keyframe.value.clone();
    }
    previous
}

fn normalize_clip_timing(clip: &mut TimelineClip) {
    clip.keyframes.retain(|keyframe| keyframe.offset_tick >= 0 && keyframe.offset_tick <= clip.duration_ticks);
    clip.keyframes.sort_by_key(|keyframe| keyframe.offset_tick);
    clip.keyframes.dedup_by_key(|keyframe| keyframe.offset_tick);
    if let Some(transition) = &mut clip.transition_in { transition.duration_ticks = transition.duration_ticks.min(clip.duration_ticks).max(1); }
    if let Some(transition) = &mut clip.transition_out { transition.duration_ticks = transition.duration_ticks.min(clip.duration_ticks).max(1); }
}

fn truncate_clip_animation(clip: &mut TimelineClip, duration_ticks: i64, boundary_id: String) {
    if !clip.keyframes.iter().any(|keyframe| keyframe.offset_tick > duration_ticks) { return; }
    let boundary = transform_at_offset(clip, duration_ticks);
    clip.keyframes.retain(|keyframe| keyframe.offset_tick <= duration_ticks);
    if !clip.keyframes.iter().any(|keyframe| keyframe.offset_tick == duration_ticks) {
        clip.keyframes.push(TransformKeyframe { id: boundary_id, offset_tick: duration_ticks, easing: "linear".into(), value: boundary });
    }
}

pub(crate) fn validate_project(project: &EditorProject) -> Result<(), AppError> {
    if project.schema_version != 2 { return Err(AppError::new("UNSUPPORTED_SCHEMA", "Versão do projeto não suportada")); }
    if project.settings.timebase != TICKS_PER_SECOND || project.settings.width == 0 || project.settings.height == 0 || project.settings.fps_num == 0 || project.settings.fps_den == 0 || project.settings.sample_rate == 0 {
        return Err(AppError::new("INVALID_PROJECT_SETTINGS", "As configurações do projeto são incompatíveis"));
    }
    project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "A sequência ativa não existe"))?;
    let mut asset_ids = HashSet::new();
    for asset in &project.assets {
        if asset.id.is_empty() || !asset_ids.insert(asset.id.as_str()) || asset.duration_ticks <= 0 || asset.width.is_some() != asset.height.is_some() {
            return Err(AppError::new("INVALID_ASSET", format!("Mídia inválida ou duplicada: {}", asset.name)));
        }
    }
    let mut sequence_ids = HashSet::new();
    let mut track_ids = HashSet::new();
    let mut clip_ids = HashSet::new();
    for sequence in &project.sequences {
        if sequence.id.is_empty() || !sequence_ids.insert(sequence.id.as_str()) { return Err(AppError::new("INVALID_SEQUENCE", "Sequência inválida ou duplicada")); }
        if !valid_caption_style(&sequence.caption_style) { return Err(AppError::new("INVALID_CAPTION_STYLE", "Estilo de legenda inválido")); }
        if sequence.captions.iter().any(|caption| caption.id.is_empty() || caption.start_tick < 0 || caption.end_tick <= caption.start_tick || caption.text.trim().is_empty()) {
            return Err(AppError::new("INVALID_CAPTION", "A sequência contém uma legenda inválida"));
        }
        for track in &sequence.tracks {
            if track.id.is_empty() || !track_ids.insert(track.id.as_str()) { return Err(AppError::new("INVALID_TRACK", "Faixa inválida ou duplicada")); }
            if !matches!(track.kind.as_str(), "video" | "audio" | "caption") { return Err(AppError::new("INVALID_TRACK_KIND", format!("Tipo de faixa inválido: {}", track.kind))); }
            for clip in &track.clips {
                if clip.id.is_empty() || !clip_ids.insert(clip.id.as_str()) || clip.duration_ticks <= 0 || clip.start_tick < 0 || clip.source_in_tick < 0 || !clip.speed.is_finite() || !(0.05..=20.0).contains(&clip.speed) || !clip.volume.is_finite() || !(0.0..=4.0).contains(&clip.volume) {
                    return Err(AppError::new("INVALID_CLIP", format!("Clipe inválido ou duplicado: {}", clip.name)));
                }
                let asset = project.assets.iter().find(|asset| asset.id == clip.asset_id).ok_or_else(|| AppError::new("ASSET_NOT_FOUND", format!("Asset ausente para {}", clip.name)))?;
                let source_end = clip.source_in_tick.saturating_add((clip.duration_ticks as f64 * clip.speed).round() as i64);
                if source_end > asset.duration_ticks + 1 || !valid_transform(&clip.transform, &project.settings) {
                    return Err(AppError::new("INVALID_CLIP", format!("Duração de fonte ou transformação inválida em {}", clip.name)));
                }
                let mut previous_tick = -1;
                for keyframe in &clip.keyframes {
                    if keyframe.id.is_empty() || keyframe.offset_tick < 0 || keyframe.offset_tick > clip.duration_ticks || keyframe.offset_tick <= previous_tick || !valid_transform(&keyframe.value, &project.settings) {
                        return Err(AppError::new("INVALID_KEYFRAME", format!("Keyframes inválidos ou fora de ordem em {}", clip.name)));
                    }
                    if !matches!(keyframe.easing.as_str(), "linear" | "easeIn" | "easeOut" | "easeInOut") {
                        return Err(AppError::new("INVALID_KEYFRAME", format!("Easing inválido em {}", clip.name)));
                    }
                    previous_tick = keyframe.offset_tick;
                }
                if clip.effects.iter().any(|effect| effect.id.is_empty() || !effect.value.is_finite() || !matches!(effect.kind.as_str(), "exposure" | "contrast" | "saturation" | "temperature" | "chromaKey" | "blur")) {
                    return Err(AppError::new("INVALID_EFFECT", format!("Efeito inválido em {}", clip.name)));
                }
                for transition in [clip.transition_in.as_ref(), clip.transition_out.as_ref()].into_iter().flatten() {
                    if transition.duration_ticks <= 0 || transition.duration_ticks > clip.duration_ticks || !matches!(transition.kind.as_str(), "crossDissolve" | "dipToBlack" | "slide" | "audioCrossfade") {
                        return Err(AppError::new("INVALID_TRANSITION", format!("Transição inválida em {}", clip.name)));
                    }
                }
            }
        }
    }
    for transcript in &project.transcripts {
        let duration = project.assets.iter().find(|asset| asset.id == transcript.asset_id).map(|asset| asset.duration_ticks).ok_or_else(|| AppError::new("ASSET_NOT_FOUND", "A transcrição referencia uma mídia inexistente"))?;
        if transcript.segments.iter().any(|segment| segment.start_tick < 0 || segment.end_tick <= segment.start_tick || segment.end_tick > duration || segment.text.trim().is_empty()) {
            return Err(AppError::new("INVALID_TRANSCRIPT", "A transcrição contém segmentos inválidos"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTransaction {
    pub id: String,
    pub base_revision: u64,
    pub source: String,
    pub label: String,
    pub commands: Vec<EditCommand>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditCommand {
    SetProjectSettings { settings: ProjectSettings },
    AddAsset { asset: MediaAsset },
    UpdateAsset { asset: MediaAsset },
    InsertClip { track_id: String, clip: TimelineClip },
    MoveClip { track_id: String, clip_id: String, start_tick: i64 },
    TrimClip { track_id: String, clip_id: String, source_in_tick: i64, duration_ticks: i64 },
    SplitClip { track_id: String, clip_id: String, at_tick: i64, right_clip_id: String },
    DeleteClip { track_id: String, clip_id: String, ripple: bool },
    UpdateClip { track_id: String, clip_id: String, patch: Value },
    SetTranscript { transcript: Transcript },
    SetCaptions { sequence_id: String, captions: Vec<CaptionCue> },
    SetCaptionStyle { sequence_id: String, style: CaptionStyle },
    AddTrack { sequence_id: String, track: TimelineTrack },
    UpdateTrack { sequence_id: String, track_id: String, patch: Value },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipPatch {
    start_tick: Option<i64>,
    source_in_tick: Option<i64>,
    duration_ticks: Option<i64>,
    speed: Option<f64>,
    volume: Option<f64>,
    transform: Option<Transform>,
    keyframes: Option<Vec<TransformKeyframe>>,
    effects: Option<Vec<EffectInstance>>,
    transition_in: Option<ClipTransition>,
    transition_out: Option<ClipTransition>,
}

#[derive(Debug, Deserialize)]
struct TrackPatch {
    name: Option<String>,
    locked: Option<bool>,
    muted: Option<bool>,
    hidden: Option<bool>,
}

fn find_track_mut<'a>(project: &'a mut EditorProject, track_id: &str) -> Option<&'a mut TimelineTrack> {
    project.active_sequence_mut()?.tracks.iter_mut().find(|track| track.id == track_id)
}

fn editable_track_mut<'a>(project: &'a mut EditorProject, track_id: &str) -> Result<&'a mut TimelineTrack, AppError> {
    let track = find_track_mut(project, track_id).ok_or_else(|| AppError::new("TRACK_NOT_FOUND", "Faixa não encontrada"))?;
    if track.locked { return Err(AppError::new("TRACK_LOCKED", "A faixa está bloqueada")); }
    Ok(track)
}

pub fn apply_command(project: &mut EditorProject, command: EditCommand) -> Result<(), AppError> {
    match command {
        EditCommand::SetProjectSettings { settings } => {
            if settings.width == 0 || settings.height == 0 || settings.fps_num == 0 || settings.fps_den == 0 || settings.timebase != TICKS_PER_SECOND {
                return Err(AppError::new("INVALID_PROJECT_SETTINGS", "Configuração de sequência inválida"));
            }
            project.settings = settings;
        }
        EditCommand::AddAsset { asset } => {
            if !project.assets.iter().any(|item| item.id == asset.id) { project.assets.push(asset); }
        }
        EditCommand::UpdateAsset { asset } => {
            let target = project.assets.iter_mut().find(|item| item.id == asset.id).ok_or_else(|| AppError::new("ASSET_NOT_FOUND", "Asset não encontrado"))?;
            *target = asset;
        }
        EditCommand::SetTranscript { transcript } => {
            project.transcripts.retain(|item| item.asset_id != transcript.asset_id);
            project.transcripts.push(transcript);
        }
        EditCommand::SetCaptions { sequence_id, captions } => {
            let sequence = project.sequences.iter_mut().find(|item| item.id == sequence_id).ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência não encontrada"))?;
            sequence.captions = captions;
        }
        EditCommand::SetCaptionStyle { sequence_id, style } => {
            if !valid_caption_style(&style) { return Err(AppError::new("INVALID_CAPTION_STYLE", "Estilo de legenda inválido")); }
            let sequence = project.sequences.iter_mut().find(|item| item.id == sequence_id).ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência não encontrada"))?;
            sequence.caption_style = style;
        }
        EditCommand::AddTrack { sequence_id, track } => {
            let sequence = project.sequences.iter_mut().find(|item| item.id == sequence_id).ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência não encontrada"))?;
            if sequence.tracks.iter().any(|item| item.id == track.id) { return Err(AppError::new("DUPLICATE_TRACK", "Já existe uma faixa com este ID")); }
            if !matches!(track.kind.as_str(), "video" | "audio" | "caption") { return Err(AppError::new("INVALID_TRACK_KIND", "Tipo de faixa inválido")); }
            sequence.tracks.push(track);
        }
        EditCommand::UpdateTrack { sequence_id, track_id, patch } => {
            let patch: TrackPatch = serde_json::from_value(patch).map_err(|error| AppError::new("INVALID_TRACK_PATCH", error.to_string()))?;
            let sequence = project.sequences.iter_mut().find(|item| item.id == sequence_id).ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência não encontrada"))?;
            let track = sequence.tracks.iter_mut().find(|item| item.id == track_id).ok_or_else(|| AppError::new("TRACK_NOT_FOUND", "Faixa não encontrada"))?;
            if let Some(name) = patch.name { track.name = name.chars().take(32).collect(); }
            if let Some(locked) = patch.locked { track.locked = locked; }
            if let Some(muted) = patch.muted { track.muted = muted; }
            if let Some(hidden) = patch.hidden { track.hidden = hidden; }
        }
        EditCommand::InsertClip { track_id, clip } => {
            if !project.assets.iter().any(|asset| asset.id == clip.asset_id) { return Err(AppError::new("ASSET_NOT_FOUND", "Asset do clipe não encontrado")); }
            if clip.duration_ticks <= 0 { return Err(AppError::new("INVALID_DURATION", "A duração do clipe deve ser positiva")); }
            let track = editable_track_mut(project, &track_id)?;
            track.clips.push(clip);
            track.clips.sort_by_key(|item| item.start_tick);
        }
        EditCommand::MoveClip { track_id, clip_id, start_tick } => {
            let track = editable_track_mut(project, &track_id)?;
            let clip = track.clips.iter_mut().find(|item| item.id == clip_id).ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
            clip.start_tick = start_tick.max(0);
            track.clips.sort_by_key(|item| item.start_tick);
        }
        EditCommand::TrimClip { track_id, clip_id, source_in_tick, duration_ticks } => {
            let track = editable_track_mut(project, &track_id)?;
            let clip = track.clips.iter_mut().find(|item| item.id == clip_id).ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
            let next_source_in = source_in_tick.max(0);
            let shifted_ticks = ((next_source_in - clip.source_in_tick) as f64 / clip.speed).round() as i64;
            if shifted_ticks > 0 {
                let next_base = transform_at_offset(clip, shifted_ticks);
                clip.keyframes = clip.keyframes.iter().filter(|keyframe| keyframe.offset_tick > shifted_ticks).cloned().map(|mut keyframe| {
                    keyframe.offset_tick -= shifted_ticks;
                    keyframe
                }).collect();
                clip.transform = next_base;
            } else if shifted_ticks < 0 {
                for keyframe in &mut clip.keyframes { keyframe.offset_tick -= shifted_ticks; }
            }
            clip.source_in_tick = next_source_in;
            let next_duration = duration_ticks.max(1);
            let boundary_id = format!("{}-trim-boundary", clip.id);
            truncate_clip_animation(clip, next_duration, boundary_id);
            clip.duration_ticks = next_duration;
            normalize_clip_timing(clip);
        }
        EditCommand::SplitClip { track_id, clip_id, at_tick, right_clip_id } => {
            let track = editable_track_mut(project, &track_id)?;
            let index = track.clips.iter().position(|item| item.id == clip_id).ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
            let clip = &mut track.clips[index];
            let left_duration = at_tick - clip.start_tick;
            if left_duration <= 0 || left_duration >= clip.duration_ticks { return Err(AppError::new("INVALID_SPLIT", "O playhead deve estar dentro do clipe")); }
            let mut right = clip.clone();
            let right_base = transform_at_offset(clip, left_duration);
            right.id = right_clip_id;
            right.start_tick = at_tick;
            right.source_in_tick += (left_duration as f64 * clip.speed).round() as i64;
            right.duration_ticks -= left_duration;
            right.transform = right_base;
            right.keyframes = clip.keyframes.iter().filter(|keyframe| keyframe.offset_tick > left_duration).cloned().map(|mut keyframe| {
                keyframe.offset_tick -= left_duration;
                keyframe
            }).collect();
            right.transition_in = None;
            truncate_clip_animation(clip, left_duration, format!("{}-split-boundary", right.id));
            clip.transition_out = None;
            clip.duration_ticks = left_duration;
            normalize_clip_timing(clip);
            normalize_clip_timing(&mut right);
            track.clips.insert(index + 1, right);
        }
        EditCommand::DeleteClip { track_id, clip_id, ripple } => {
            let track = editable_track_mut(project, &track_id)?;
            let index = track.clips.iter().position(|item| item.id == clip_id).ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
            let removed = track.clips.remove(index);
            if ripple {
                let end = removed.start_tick + removed.duration_ticks;
                for clip in &mut track.clips {
                    if clip.start_tick >= end { clip.start_tick -= removed.duration_ticks; }
                }
            }
        }
        EditCommand::UpdateClip { track_id, clip_id, patch } => {
            let patch: ClipPatch = serde_json::from_value(patch).map_err(|error| AppError::new("INVALID_PATCH", error.to_string()))?;
            let track = editable_track_mut(project, &track_id)?;
            let clip = track.clips.iter_mut().find(|item| item.id == clip_id).ok_or_else(|| AppError::new("CLIP_NOT_FOUND", "Clipe não encontrado"))?;
            if let Some(value) = patch.start_tick { clip.start_tick = value.max(0); }
            if let Some(value) = patch.source_in_tick { clip.source_in_tick = value.max(0); }
            if let Some(value) = patch.duration_ticks {
                let next_duration = value.max(1);
                if patch.keyframes.is_none() {
                    let boundary_id = format!("{}-duration-boundary", clip.id);
                    truncate_clip_animation(clip, next_duration, boundary_id);
                }
                clip.duration_ticks = next_duration;
            }
            if let Some(value) = patch.speed {
                let next_speed = value.clamp(0.05, 20.0);
                if patch.duration_ticks.is_none() {
                    let old_duration = clip.duration_ticks;
                    let next_duration = ((old_duration as f64 * clip.speed) / next_speed).round().max(1.0) as i64;
                    for keyframe in &mut clip.keyframes { keyframe.offset_tick = (keyframe.offset_tick as f64 * next_duration as f64 / old_duration.max(1) as f64).round() as i64; }
                    clip.duration_ticks = next_duration;
                }
                clip.speed = next_speed;
            }
            if let Some(value) = patch.volume { clip.volume = value.clamp(0.0, 4.0); }
            if let Some(value) = patch.transform { clip.transform = value; }
            if let Some(mut value) = patch.keyframes {
                value.sort_by_key(|keyframe| keyframe.offset_tick);
                value.dedup_by_key(|keyframe| keyframe.offset_tick);
                if value.iter().any(|keyframe| keyframe.offset_tick < 0 || keyframe.offset_tick > clip.duration_ticks || !matches!(keyframe.easing.as_str(), "linear" | "easeIn" | "easeOut" | "easeInOut")) {
                    return Err(AppError::new("INVALID_KEYFRAME", "Keyframes inválidos"));
                }
                clip.keyframes = value;
            }
            if let Some(value) = patch.effects { clip.effects = value; }
            if let Some(value) = patch.transition_in { clip.transition_in = Some(value); }
            if let Some(value) = patch.transition_out { clip.transition_out = Some(value); }
            normalize_clip_timing(clip);
        }
    }
    Ok(())
}

fn apply_transaction(project: &EditorProject, transaction: EditTransaction) -> Result<EditorProject, AppError> {
    if transaction.base_revision != project.revision {
        return Err(AppError::retryable("STALE_REVISION", format!("Revisão atual: {}", project.revision)));
    }
    let mut next = project.clone();
    for command in transaction.commands { apply_command(&mut next, command)?; }
    validate_project(&next)?;
    next.revision += 1;
    Ok(next)
}

pub struct AppState {
    pub project: Mutex<EditorProject>,
    pub past: Mutex<Vec<EditorProject>>,
    pub future: Mutex<Vec<EditorProject>>,
    pub gemini_key: Mutex<Option<String>>,
    pub render_cancel: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStatus {
    pub can_undo: bool,
    pub can_redo: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            project: Mutex::new(EditorProject::empty("Projeto sem título")),
            past: Mutex::new(Vec::new()),
            future: Mutex::new(Vec::new()),
            gemini_key: Mutex::new(None),
            render_cancel: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
pub fn project_snapshot(state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    Ok(state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.clone())
}

#[tauri::command]
pub fn project_history_status(state: tauri::State<'_, AppState>) -> Result<HistoryStatus, AppError> {
    Ok(HistoryStatus {
        can_undo: !state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.is_empty(),
        can_redo: !state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.is_empty(),
    })
}

#[tauri::command]
pub fn project_new(name: String, state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    let project = EditorProject::empty(name);
    *state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))? = project.clone();
    state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.clear();
    state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.clear();
    Ok(project)
}

#[tauri::command]
pub fn project_apply(transaction: EditTransaction, state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    let mut project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?;
    let previous = project.clone();
    let output = apply_transaction(&previous, transaction)?;
    *project = output.clone();
    drop(project);
    let mut past = state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?;
    past.push(previous);
    if past.len() > 50 { past.remove(0); }
    state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.clear();
    Ok(output)
}

#[tauri::command]
pub fn project_undo(state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    let previous = state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.pop();
    let Some(previous) = previous else { return project_snapshot(state); };
    let mut project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?;
    state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.insert(0, project.clone());
    *project = previous.clone();
    Ok(previous)
}

#[tauri::command]
pub fn project_redo(state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    let next = {
        let mut future = state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?;
        if future.is_empty() { None } else { Some(future.remove(0)) }
    };
    let Some(next) = next else { return project_snapshot(state); };
    let mut project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?;
    state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.push(project.clone());
    *project = next.clone();
    Ok(next)
}

#[tauri::command]
pub async fn project_save(path: String, state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    let project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.clone();
    let data = serde_json::to_vec_pretty(&project)?;
    atomic_write(Path::new(&path), &data).await?;
    Ok(())
}

async fn atomic_write(path: &Path, data: &[u8]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() { tokio::fs::create_dir_all(parent).await?; }
    let temp_path = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temp_path, data).await?;
    if path.exists() { tokio::fs::remove_file(path).await?; }
    if let Err(error) = tokio::fs::rename(&temp_path, path).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(error.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn project_autosave(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<String, AppError> {
    let project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.clone();
    let directory = app.path().app_data_dir().map_err(|error| AppError::new("APP_DATA_PATH", error.to_string()))?.join("autosave");
    let path = directory.join(format!("{}.aivedit.autosave", project.project_id));
    atomic_write(&path, &serde_json::to_vec_pretty(&project)?).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn project_open(path: String, app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<EditorProject, AppError> {
    let data = tokio::fs::read(path).await?;
    let mut project: EditorProject = serde_json::from_slice(&data)?;
    validate_project(&project)?;
    for asset in &mut project.assets {
        let original = asset.path.as_deref().map(Path::new).filter(|path| path.is_file());
        asset.offline = original.is_none();
        if let Some(path) = original { allow_asset_file(&app, path)?; }
        let proxy = asset.proxy_path.as_deref().map(Path::new).filter(|path| path.is_file());
        if let Some(path) = proxy { allow_asset_file(&app, path)?; }
        else { asset.proxy_path = None; }
    }
    *state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))? = project.clone();
    state.past.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.clear();
    state.future.lock().map_err(|_| AppError::new("STATE_POISONED", "Histórico indisponível"))?.clear();
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deserializes_frontend_insert_clip_payload_in_camel_case() {
        let payload = json!({
            "type": "insertClip",
            "trackId": "track-video",
            "clip": {
                "id": "clip",
                "assetId": "asset",
                "name": "clip.mp4",
                "startTick": 0,
                "sourceInTick": 0,
                "durationTicks": 240000,
                "speed": 1.0,
                "volume": 1.0,
                "transform": {
                    "x": 0.0, "y": 0.0, "scale": 1.0, "rotation": 0.0, "opacity": 1.0,
                    "cropTop": 0.0, "cropRight": 0.0, "cropBottom": 0.0, "cropLeft": 0.0
                },
                "keyframes": [],
                "effects": []
            }
        });
        let command: EditCommand = serde_json::from_value(payload).unwrap();
        let EditCommand::InsertClip { track_id, clip } = command else { panic!("comando inesperado") };
        assert_eq!(track_id, "track-video");
        assert_eq!(clip.asset_id, "asset");
    }

    #[test]
    fn split_preserves_duration() {
        let mut project = EditorProject::empty("Test");
        project.assets.push(MediaAsset { id: "asset".into(), name: "Test".into(), path: None, object_url: None, duration_ticks: 2_400_000, width: Some(1920), height: Some(1080), fps: Some(30.0), codec: Some("h264".into()), has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false });
        let track_id = project.active_sequence().unwrap().tracks[0].id.clone();
        let end_transform = Transform { x: 100.0, scale: 2.0, ..Transform::default() };
        let clip = TimelineClip {
            id: "clip".into(), asset_id: "asset".into(), name: "Test".into(), start_tick: 0, source_in_tick: 0,
            duration_ticks: 2_400_000, speed: 1.0, volume: 1.0, transform: Transform::default(),
            keyframes: vec![
                TransformKeyframe { id: "start".into(), offset_tick: 0, easing: "linear".into(), value: Transform::default() },
                TransformKeyframe { id: "end".into(), offset_tick: 2_400_000, easing: "linear".into(), value: end_transform },
            ], effects: vec![], transition_in: None, transition_out: None,
        };
        apply_command(&mut project, EditCommand::InsertClip { track_id: track_id.clone(), clip }).unwrap();
        apply_command(&mut project, EditCommand::SplitClip { track_id, clip_id: "clip".into(), at_tick: 960_000, right_clip_id: "right".into() }).unwrap();
        let clips = &project.active_sequence().unwrap().tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].duration_ticks + clips[1].duration_ticks, 2_400_000);
        let left_boundary = transform_at_offset(&clips[0], clips[0].duration_ticks);
        let right_boundary = transform_at_offset(&clips[1], 0);
        assert!((left_boundary.x - 40.0).abs() < f64::EPSILON);
        assert!((left_boundary.scale - 1.4).abs() < f64::EPSILON);
        assert_eq!(left_boundary, right_boundary);
    }

    #[test]
    fn failed_transaction_does_not_mutate_source_project() {
        let project = EditorProject::empty("Test");
        let transaction = EditTransaction {
            id: "transaction".into(), base_revision: 0, source: "agent".into(), label: "invalid".into(),
            commands: vec![
                EditCommand::AddAsset { asset: MediaAsset { id: "asset".into(), name: "Test".into(), path: None, object_url: None, duration_ticks: 10, width: None, height: None, fps: None, codec: None, has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false } },
                EditCommand::MoveClip { track_id: "missing".into(), clip_id: "missing".into(), start_tick: 1 },
            ],
        };
        assert!(apply_transaction(&project, transaction).is_err());
        assert!(project.assets.is_empty());
        assert_eq!(project.revision, 0);
    }

    #[test]
    fn rejects_projects_with_dangling_clip_assets() {
        let mut project = EditorProject::empty("Test");
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "missing".into(), name: "Missing".into(), start_tick: 0, source_in_tick: 0, duration_ticks: 1, speed: 1.0, volume: 1.0, transform: Transform::default(), keyframes: vec![], effects: vec![], transition_in: None, transition_out: None });
        assert!(validate_project(&project).is_err());
    }
}
