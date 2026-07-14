use crate::{
    domain::TICKS_PER_SECOND,
    error::AppError,
    media::allow_asset_file,
    runtime::ffmpeg_binary,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tokio::{process::Command, sync::Semaphore};
use uuid::Uuid;

pub const ANALYSIS_PIPELINE_VERSION: &str = "local-v1";
const SCENE_THRESHOLD: f64 = 0.28;
const MAX_SCENES: usize = 240;
const MAX_OCR_SCENES: usize = 80;
const MAX_OBJECT_SCENES: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisRequest {
    pub asset_id: String,
    pub media_path: String,
    pub fingerprint: String,
    pub duration_ticks: i64,
    #[serde(default)]
    pub prompts: Vec<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisStage {
    pub kind: String,
    pub state: String,
    pub progress: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisualObservation {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub confidence: f64,
    pub rect: NormalizedRect,
    pub start_tick: i64,
    pub end_tick: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneAnalysis {
    pub id: String,
    pub start_tick: i64,
    pub end_tick: i64,
    pub representative_tick: i64,
    pub motion_score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_path: Option<String>,
    pub observations: Vec<VisualObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAnalysis {
    pub schema_version: u32,
    pub asset_id: String,
    pub source_fingerprint: String,
    pub pipeline_version: String,
    pub stages: Vec<AnalysisStage>,
    pub scenes: Vec<SceneAnalysis>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisJob {
    id: String,
    kind: String,
    label: String,
    state: String,
    progress: f64,
    detail: Option<String>,
    asset_id: String,
    stage: String,
    cancellable: bool,
    retryable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisProgressEvent {
    job: AnalysisJob,
    #[serde(skip_serializing_if = "Option::is_none")]
    analysis: Option<AssetAnalysis>,
}

struct AnalysisInner {
    records: Mutex<HashMap<String, AssetAnalysis>>,
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    slots: Semaphore,
}

#[derive(Clone)]
pub struct AnalysisState {
    inner: Arc<AnalysisInner>,
}

impl Default for AnalysisState {
    fn default() -> Self {
        Self {
            inner: Arc::new(AnalysisInner {
                records: Mutex::new(HashMap::new()),
                cancellations: Mutex::new(HashMap::new()),
                slots: Semaphore::new(1),
            }),
        }
    }
}

impl AnalysisState {
    pub fn records_for_assets<'a>(&self, asset_ids: impl IntoIterator<Item = &'a str>) -> Result<Vec<AssetAnalysis>, AppError> {
        let records = self.inner.records.lock().map_err(|_| AppError::new("STATE_POISONED", "Índice de análise indisponível"))?;
        Ok(asset_ids.into_iter().filter_map(|asset_id| records.get(asset_id).cloned()).collect())
    }
}

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |duration| duration.as_millis() as u64)
}

fn new_stage(kind: &str) -> AnalysisStage {
    AnalysisStage { kind: kind.into(), state: "queued".into(), progress: 0.0, detail: None, updated_at: now_millis() }
}

fn empty_analysis(request: &AnalysisRequest) -> AssetAnalysis {
    AssetAnalysis {
        schema_version: 1,
        asset_id: request.asset_id.clone(),
        source_fingerprint: request.fingerprint.clone(),
        pipeline_version: ANALYSIS_PIPELINE_VERSION.into(),
        stages: ["scenes", "objects", "ocr"].into_iter().map(new_stage).collect(),
        scenes: Vec::new(),
        updated_at: now_millis(),
    }
}

fn update_stage(analysis: &mut AssetAnalysis, kind: &str, state: &str, progress: f64, detail: Option<String>) {
    if let Some(stage) = analysis.stages.iter_mut().find(|stage| stage.kind == kind) {
        stage.state = state.into();
        stage.progress = progress.clamp(0.0, 1.0);
        stage.detail = detail;
        stage.updated_at = now_millis();
    }
    analysis.updated_at = now_millis();
}

fn emit_progress(window: &tauri::Window, analysis: &AssetAnalysis, stage: &str) {
    let current = analysis.stages.iter().find(|item| item.kind == stage);
    let job = AnalysisJob {
        id: format!("analysis-{}", analysis.asset_id),
        kind: "analysis".into(),
        label: format!("Análise local · {stage}"),
        state: current.map_or("queued", |item| item.state.as_str()).into(),
        progress: current.map_or(0.0, |item| item.progress),
        detail: current.and_then(|item| item.detail.clone()),
        asset_id: analysis.asset_id.clone(),
        stage: stage.into(),
        cancellable: true,
        retryable: current.is_some_and(|item| item.state == "failed"),
    };
    let _ = window.emit("analysis-progress", AnalysisProgressEvent { job, analysis: Some(analysis.clone()) });
}

fn safe_fingerprint(value: &str) -> Result<&str, AppError> {
    (!value.is_empty() && value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
        .then_some(value)
        .ok_or_else(|| AppError::new("ANALYSIS_FINGERPRINT", "Fingerprint de análise inválido"))
}

fn analysis_directory(app: &tauri::AppHandle, fingerprint: &str) -> Result<PathBuf, AppError> {
    let fingerprint = safe_fingerprint(fingerprint)?;
    Ok(app.path().app_cache_dir().map_err(|error| AppError::new("CACHE_PATH", error.to_string()))?
        .join("analysis").join(ANALYSIS_PIPELINE_VERSION).join(fingerprint))
}

fn cache_path(app: &tauri::AppHandle, fingerprint: &str) -> Result<PathBuf, AppError> {
    Ok(analysis_directory(app, fingerprint)?.join("analysis.json"))
}

async fn load_cached(app: &tauri::AppHandle, asset_id: &str, fingerprint: &str) -> Result<Option<AssetAnalysis>, AppError> {
    let path = cache_path(app, fingerprint)?;
    let Ok(bytes) = tokio::fs::read(path).await else { return Ok(None); };
    let mut analysis: AssetAnalysis = serde_json::from_slice(&bytes)?;
    if analysis.schema_version != 1 || analysis.pipeline_version != ANALYSIS_PIPELINE_VERSION || analysis.source_fingerprint != fingerprint {
        return Ok(None);
    }
    analysis.asset_id = asset_id.into();
    for scene in &analysis.scenes {
        if let Some(path) = scene.thumbnail_path.as_deref() {
            let path = Path::new(path);
            if path.is_file() { allow_asset_file(app, path)?; }
        }
    }
    Ok(Some(analysis))
}

async fn save_cached(app: &tauri::AppHandle, analysis: &AssetAnalysis) -> Result<(), AppError> {
    let directory = analysis_directory(app, &analysis.source_fingerprint)?;
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join("analysis.json");
    let temporary = directory.join(format!("analysis.{}.tmp", Uuid::new_v4()));
    tokio::fs::write(&temporary, serde_json::to_vec(analysis)?).await?;
    if path.is_file() { tokio::fs::remove_file(&path).await?; }
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}

fn parse_scene_metadata(stderr: &str, duration_ticks: i64) -> Vec<(i64, f64)> {
    let mut points = vec![(0, 0.0)];
    let mut pending_tick = None;
    for line in stderr.lines() {
        if let Some(value) = line.split("pts_time:").nth(1).and_then(|tail| tail.split_whitespace().next()).and_then(|value| value.parse::<f64>().ok()) {
            pending_tick = Some((value * TICKS_PER_SECOND as f64).round() as i64);
        }
        if let Some(value) = line.split("lavfi.scene_score=").nth(1).and_then(|value| value.trim().parse::<f64>().ok()) {
            if let Some(tick) = pending_tick.take() {
                if tick > 0 && tick < duration_ticks { points.push((tick, value)); }
            }
        }
    }
    points.sort_by_key(|point| point.0);
    points.dedup_by(|left, right| (left.0 - right.0).abs() < TICKS_PER_SECOND / 3);
    points.truncate(MAX_SCENES);
    points
}

async fn detect_scene_points(path: &Path, duration_ticks: i64) -> Result<Vec<(i64, f64)>, AppError> {
    let filter = format!("select='gt(scene,{SCENE_THRESHOLD})',metadata=print:key=lavfi.scene_score,showinfo");
    let output = Command::new(ffmpeg_binary())
        .args(["-hide_banner", "-v", "info", "-i"]).arg(path)
        .args(["-vf", &filter, "-an", "-f", "null", "-"])
        .output().await
        .map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível detectar cenas: {error}")))?;
    if !output.status.success() {
        return Err(AppError::new("SCENE_DETECTION_FAILED", String::from_utf8_lossy(&output.stderr).lines().last().unwrap_or("FFmpeg falhou").to_string()));
    }
    Ok(parse_scene_metadata(&String::from_utf8_lossy(&output.stderr), duration_ticks))
}

fn build_scenes(points: &[(i64, f64)], duration_ticks: i64) -> Vec<SceneAnalysis> {
    let duration = duration_ticks.max(1);
    let mut boundaries = points.iter().map(|point| point.0.clamp(0, duration)).collect::<Vec<_>>();
    if boundaries.first().copied() != Some(0) { boundaries.insert(0, 0); }
    if boundaries.last().copied() != Some(duration) { boundaries.push(duration); }
    boundaries.sort_unstable();
    boundaries.dedup();
    boundaries.windows(2).filter_map(|window| {
        let start = window[0];
        let end = window[1];
        (end > start).then(|| SceneAnalysis {
            id: format!("scene-{}", Uuid::new_v4()),
            start_tick: start,
            end_tick: end,
            representative_tick: start + (end - start) / 2,
            motion_score: points.iter().find(|point| point.0 == start).map_or(0.0, |point| point.1).clamp(0.0, 1.0),
            thumbnail_path: None,
            observations: Vec::new(),
        })
    }).collect()
}

async fn extract_thumbnail(source: &Path, output: &Path, tick: i64) -> Result<(), AppError> {
    let seconds = tick as f64 / TICKS_PER_SECOND as f64;
    let result = Command::new(ffmpeg_binary())
        .args(["-hide_banner", "-v", "error", "-y", "-ss", &format!("{seconds:.6}"), "-i"]).arg(source)
        .args(["-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease", "-q:v", "4"])
        .arg(output).output().await
        .map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível extrair frame: {error}")))?;
    if result.status.success() { Ok(()) } else { Err(AppError::new("FRAME_EXTRACTION_FAILED", String::from_utf8_lossy(&result.stderr).trim().to_string())) }
}

#[derive(Debug)]
struct OcrLine {
    text: String,
    confidence: f64,
    rect: NormalizedRect,
}

fn parse_tesseract_tsv(tsv: &str) -> Vec<OcrLine> {
    #[derive(Default)]
    struct Aggregate { text: Vec<String>, confidence: f64, count: usize, left: f64, top: f64, right: f64, bottom: f64 }
    let mut page_width = 1.0;
    let mut page_height = 1.0;
    let mut lines: HashMap<(i32, i32, i32), Aggregate> = HashMap::new();
    for row in tsv.lines().skip(1) {
        let columns = row.split('\t').collect::<Vec<_>>();
        if columns.len() < 12 { continue; }
        let level = columns[0].parse::<i32>().unwrap_or_default();
        let width = columns[8].parse::<f64>().unwrap_or_default();
        let height = columns[9].parse::<f64>().unwrap_or_default();
        if level == 1 {
            page_width = width.max(1.0);
            page_height = height.max(1.0);
            continue;
        }
        if level != 5 { continue; }
        let text = columns[11].trim();
        let confidence = columns[10].parse::<f64>().unwrap_or(-1.0);
        if text.is_empty() || confidence < 20.0 { continue; }
        let left = columns[6].parse::<f64>().unwrap_or_default();
        let top = columns[7].parse::<f64>().unwrap_or_default();
        let key = (columns[2].parse().unwrap_or_default(), columns[3].parse().unwrap_or_default(), columns[4].parse().unwrap_or_default());
        let aggregate = lines.entry(key).or_insert_with(|| Aggregate { left, top, right: left + width, bottom: top + height, ..Aggregate::default() });
        aggregate.text.push(text.into());
        aggregate.confidence += confidence;
        aggregate.count += 1;
        aggregate.left = aggregate.left.min(left);
        aggregate.top = aggregate.top.min(top);
        aggregate.right = aggregate.right.max(left + width);
        aggregate.bottom = aggregate.bottom.max(top + height);
    }
    let mut output = lines.into_values().filter(|line| !line.text.is_empty()).map(|line| OcrLine {
        text: line.text.join(" "),
        confidence: (line.confidence / line.count.max(1) as f64 / 100.0).clamp(0.0, 1.0),
        rect: NormalizedRect {
            x: (line.left / page_width).clamp(0.0, 1.0),
            y: (line.top / page_height).clamp(0.0, 1.0),
            width: ((line.right - line.left) / page_width).clamp(0.0, 1.0),
            height: ((line.bottom - line.top) / page_height).clamp(0.0, 1.0),
        },
    }).collect::<Vec<_>>();
    output.sort_by(|left, right| left.rect.y.total_cmp(&right.rect.y).then(left.rect.x.total_cmp(&right.rect.x)));
    output
}

async fn tesseract_available() -> bool {
    Command::new(std::env::var_os("TESSERACT_PATH").map_or_else(|| PathBuf::from("tesseract"), PathBuf::from))
        .arg("--version").output().await.is_ok_and(|output| output.status.success())
}

async fn run_ocr(frame: &Path) -> Result<Vec<OcrLine>, AppError> {
    let binary = std::env::var_os("TESSERACT_PATH").map_or_else(|| PathBuf::from("tesseract"), PathBuf::from);
    let language = std::env::var("TESSERACT_LANG").unwrap_or_else(|_| "por+eng".into());
    let mut output = Command::new(&binary).arg(frame).arg("stdout").args(["-l", &language, "--psm", "11", "tsv"]).output().await
        .map_err(|error| AppError::new("OCR_NOT_FOUND", error.to_string()))?;
    if !output.status.success() && language != "eng" {
        output = Command::new(binary).arg(frame).arg("stdout").args(["-l", "eng", "--psm", "11", "tsv"]).output().await?;
    }
    if !output.status.success() { return Err(AppError::new("OCR_FAILED", String::from_utf8_lossy(&output.stderr).trim().to_string())); }
    Ok(parse_tesseract_tsv(&String::from_utf8_lossy(&output.stdout)))
}

fn default_object_prompts() -> Vec<String> {
    ["person", "phone", "computer", "screen", "document", "product", "vehicle", "tool", "chart", "sign"]
        .into_iter().map(str::to_owned).collect()
}

fn normalized_prompts(values: &[String]) -> Vec<String> {
    let source = if values.is_empty() { default_object_prompts() } else { values.to_vec() };
    let mut output = Vec::new();
    for value in source {
        let value = value.trim().chars().take(48).collect::<String>();
        if !value.is_empty() && !output.iter().any(|item: &String| item.to_lowercase() == value.to_lowercase()) { output.push(value); }
        if output.len() == 32 { break; }
    }
    output
}

fn parse_detector_output(value: &Value, scene: &SceneAnalysis) -> Vec<VisualObservation> {
    let detections = value.get("detections").and_then(Value::as_array).or_else(|| value.as_array()).cloned().unwrap_or_default();
    detections.into_iter().filter_map(|detection| {
        let label = detection.get("label")?.as_str()?.trim();
        if label.is_empty() { return None; }
        let confidence = detection.get("confidence").and_then(Value::as_f64).unwrap_or_default().clamp(0.0, 1.0);
        let rect = detection.get("rect").or_else(|| detection.get("box"))?;
        let normalized = NormalizedRect {
            x: rect.get("x").and_then(Value::as_f64)?.clamp(0.0, 1.0),
            y: rect.get("y").and_then(Value::as_f64)?.clamp(0.0, 1.0),
            width: rect.get("width").or_else(|| rect.get("w")).and_then(Value::as_f64)?.clamp(0.0, 1.0),
            height: rect.get("height").or_else(|| rect.get("h")).and_then(Value::as_f64)?.clamp(0.0, 1.0),
        };
        Some(VisualObservation {
            id: format!("observation-{}", Uuid::new_v4()),
            kind: if label.eq_ignore_ascii_case("person") { "person".into() } else { "object".into() },
            label: label.into(),
            text: None,
            confidence,
            rect: normalized,
            start_tick: scene.start_tick,
            end_tick: scene.end_tick,
            track_id: None,
        })
    }).collect()
}

async fn run_detector(frame: &Path, prompts: &[String], scene: &SceneAnalysis) -> Result<Vec<VisualObservation>, AppError> {
    let binary = std::env::var_os("YOLO_WORLD_PATH").map(PathBuf::from).ok_or_else(|| AppError::new("OBJECT_DETECTOR_MISSING", "YOLO_WORLD_PATH não está configurado"))?;
    let output = Command::new(binary)
        .arg("--input").arg(frame)
        .arg("--labels-json").arg(serde_json::to_string(prompts)?)
        .arg("--output").arg("json")
        .output().await
        .map_err(|error| AppError::new("OBJECT_DETECTOR_FAILED", error.to_string()))?;
    if !output.status.success() { return Err(AppError::new("OBJECT_DETECTOR_FAILED", String::from_utf8_lossy(&output.stderr).trim().to_string())); }
    Ok(parse_detector_output(&serde_json::from_slice(&output.stdout)?, scene))
}

fn intersection_over_union(left: &NormalizedRect, right: &NormalizedRect) -> f64 {
    let x1 = left.x.max(right.x);
    let y1 = left.y.max(right.y);
    let x2 = (left.x + left.width).min(right.x + right.width);
    let y2 = (left.y + left.height).min(right.y + right.height);
    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    let union = left.width * left.height + right.width * right.height - intersection;
    if union <= 0.0 { 0.0 } else { intersection / union }
}

fn link_object_tracks(scenes: &mut [SceneAnalysis]) {
    let mut previous = Vec::<VisualObservation>::new();
    for scene in scenes {
        for observation in scene.observations.iter_mut().filter(|observation| observation.kind != "text") {
            let matching = previous.iter().filter(|candidate| candidate.label.eq_ignore_ascii_case(&observation.label))
                .max_by(|left, right| intersection_over_union(&left.rect, &observation.rect).total_cmp(&intersection_over_union(&right.rect, &observation.rect)));
            observation.track_id = matching.filter(|candidate| intersection_over_union(&candidate.rect, &observation.rect) >= 0.2)
                .and_then(|candidate| candidate.track_id.clone())
                .or_else(|| Some(format!("track-{}", Uuid::new_v4())));
        }
        previous = scene.observations.iter().filter(|observation| observation.kind != "text").cloned().collect();
    }
}

fn cancelled(flag: &AtomicBool) -> Result<(), AppError> {
    if flag.load(Ordering::Relaxed) { Err(AppError::new("ANALYSIS_CANCELLED", "Análise cancelada")) } else { Ok(()) }
}

#[tauri::command]
pub async fn analysis_get(asset_id: String, fingerprint: String, app: tauri::AppHandle, state: tauri::State<'_, AnalysisState>) -> Result<Option<AssetAnalysis>, AppError> {
    if let Some(analysis) = state.inner.records.lock().map_err(|_| AppError::new("STATE_POISONED", "Índice de análise indisponível"))?.get(&asset_id).cloned() {
        if analysis.source_fingerprint == fingerprint { return Ok(Some(analysis)); }
    }
    let cached = load_cached(&app, &asset_id, &fingerprint).await?;
    if let Some(analysis) = cached.clone() {
        state.inner.records.lock().map_err(|_| AppError::new("STATE_POISONED", "Índice de análise indisponível"))?.insert(asset_id, analysis);
    }
    Ok(cached)
}

#[tauri::command]
pub fn analysis_cancel(asset_id: String, state: tauri::State<'_, AnalysisState>) -> Result<(), AppError> {
    if let Some(flag) = state.inner.cancellations.lock().map_err(|_| AppError::new("STATE_POISONED", "Cancelamentos indisponíveis"))?.get(&asset_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn analysis_start(request: AnalysisRequest, window: tauri::Window, app: tauri::AppHandle, state: tauri::State<'_, AnalysisState>) -> Result<AssetAnalysis, AppError> {
    let source = tokio::fs::canonicalize(&request.media_path).await.map_err(|_| AppError::new("MEDIA_NOT_FOUND", "A mídia para análise não foi encontrada"))?;
    if !request.force {
        if let Some(cached) = analysis_get(request.asset_id.clone(), request.fingerprint.clone(), app.clone(), state.clone()).await? { return Ok(cached); }
    }

    let cancellation = Arc::new(AtomicBool::new(false));
    state.inner.cancellations.lock().map_err(|_| AppError::new("STATE_POISONED", "Cancelamentos indisponíveis"))?.insert(request.asset_id.clone(), cancellation.clone());
    let mut analysis = empty_analysis(&request);
    emit_progress(&window, &analysis, "scenes");
    let _permit = state.inner.slots.acquire().await.map_err(|_| AppError::new("ANALYSIS_SCHEDULER", "Fila de análise encerrada"))?;

    let result = async {
        cancelled(&cancellation)?;
        update_stage(&mut analysis, "scenes", "running", 0.02, Some("Detectando mudanças visuais".into()));
        emit_progress(&window, &analysis, "scenes");
        let points = detect_scene_points(&source, request.duration_ticks).await.unwrap_or_else(|_| vec![(0, 0.0)]);
        analysis.scenes = build_scenes(&points, request.duration_ticks);
        let frames_directory = analysis_directory(&app, &request.fingerprint)?.join("frames");
        tokio::fs::create_dir_all(&frames_directory).await?;
        let scene_count = analysis.scenes.len().max(1);
        for index in 0..analysis.scenes.len() {
            cancelled(&cancellation)?;
            let frame_path = frames_directory.join(format!("{:04}.jpg", index));
            let representative_tick = analysis.scenes[index].representative_tick;
            if !frame_path.is_file() { extract_thumbnail(&source, &frame_path, representative_tick).await?; }
            allow_asset_file(&app, &frame_path)?;
            analysis.scenes[index].thumbnail_path = Some(frame_path.to_string_lossy().into_owned());
            update_stage(&mut analysis, "scenes", "running", 0.1 + 0.9 * (index + 1) as f64 / scene_count as f64, Some(format!("{} de {} cenas", index + 1, scene_count)));
            if index % 4 == 0 || index + 1 == scene_count { emit_progress(&window, &analysis, "scenes"); }
        }
        let detected_scene_count = analysis.scenes.len();
        update_stage(&mut analysis, "scenes", "completed", 1.0, Some(format!("{} cenas", detected_scene_count)));
        emit_progress(&window, &analysis, "scenes");

        cancelled(&cancellation)?;
        let detector = std::env::var_os("YOLO_WORLD_PATH").map(PathBuf::from).filter(|path| path.is_file());
        if detector.is_none() {
            update_stage(&mut analysis, "objects", "skipped", 1.0, Some("Configure YOLO_WORLD_PATH para detectar objetos".into()));
            emit_progress(&window, &analysis, "objects");
        } else {
            let prompts = normalized_prompts(&request.prompts);
            update_stage(&mut analysis, "objects", "running", 0.0, Some(format!("{} categorias", prompts.len())));
            emit_progress(&window, &analysis, "objects");
            let limit = analysis.scenes.len().clamp(1, MAX_OBJECT_SCENES);
            for index in 0..limit {
                cancelled(&cancellation)?;
                let scene_snapshot = analysis.scenes[index].clone();
                if let Some(path) = scene_snapshot.thumbnail_path.as_deref() {
                    let detections = run_detector(Path::new(path), &prompts, &scene_snapshot).await?;
                    analysis.scenes[index].observations.extend(detections);
                }
                update_stage(&mut analysis, "objects", "running", (index + 1) as f64 / limit as f64, Some(format!("{} de {} cenas", index + 1, limit)));
                if index % 4 == 0 || index + 1 == limit { emit_progress(&window, &analysis, "objects"); }
            }
            link_object_tracks(&mut analysis.scenes);
            let count = analysis.scenes.iter().map(|scene| scene.observations.len()).sum::<usize>();
            update_stage(&mut analysis, "objects", "completed", 1.0, Some(format!("{} detecções", count)));
            emit_progress(&window, &analysis, "objects");
        }

        cancelled(&cancellation)?;
        if !tesseract_available().await {
            update_stage(&mut analysis, "ocr", "skipped", 1.0, Some("Instale Tesseract ou configure TESSERACT_PATH".into()));
            emit_progress(&window, &analysis, "ocr");
        } else {
            update_stage(&mut analysis, "ocr", "running", 0.0, Some("Lendo textos visíveis".into()));
            emit_progress(&window, &analysis, "ocr");
            let limit = analysis.scenes.len().clamp(1, MAX_OCR_SCENES);
            for index in 0..limit {
                cancelled(&cancellation)?;
                let scene = &mut analysis.scenes[index];
                if let Some(path) = scene.thumbnail_path.as_deref() {
                    for line in run_ocr(Path::new(path)).await? {
                        scene.observations.push(VisualObservation {
                            id: format!("observation-{}", Uuid::new_v4()),
                            kind: "text".into(),
                            label: "texto visível".into(),
                            text: Some(line.text),
                            confidence: line.confidence,
                            rect: line.rect,
                            start_tick: scene.start_tick,
                            end_tick: scene.end_tick,
                            track_id: None,
                        });
                    }
                }
                update_stage(&mut analysis, "ocr", "running", (index + 1) as f64 / limit as f64, Some(format!("{} de {} cenas", index + 1, limit)));
                if index % 4 == 0 || index + 1 == limit { emit_progress(&window, &analysis, "ocr"); }
            }
            let count = analysis.scenes.iter().flat_map(|scene| &scene.observations).filter(|observation| observation.kind == "text").count();
            update_stage(&mut analysis, "ocr", "completed", 1.0, Some(format!("{} regiões de texto", count)));
            emit_progress(&window, &analysis, "ocr");
        }

        save_cached(&app, &analysis).await?;
        state.inner.records.lock().map_err(|_| AppError::new("STATE_POISONED", "Índice de análise indisponível"))?.insert(request.asset_id.clone(), analysis.clone());
        Ok::<_, AppError>(analysis.clone())
    }.await;

    if let Err(error) = &result {
        let current_stage = analysis.stages.iter().find(|stage| stage.state == "running").map(|stage| stage.kind.clone()).unwrap_or_else(|| "scenes".into());
        let state_name = if error.code == "ANALYSIS_CANCELLED" { "cancelled" } else { "failed" };
        update_stage(&mut analysis, &current_stage, state_name, 0.0, Some(error.message.clone()));
        emit_progress(&window, &analysis, &current_stage);
    }
    state.inner.cancellations.lock().map_err(|_| AppError::new("STATE_POISONED", "Cancelamentos indisponíveis"))?.remove(&request.asset_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scene_points_and_builds_contiguous_segments() {
        let stderr = "[Parsed_showinfo_2] n: 1 pts: 240000 pts_time:1.0\n[Parsed_metadata_1] lavfi.scene_score=0.420000\n[Parsed_showinfo_2] n: 2 pts: 720000 pts_time:3.0\n[Parsed_metadata_1] lavfi.scene_score=0.750000";
        let points = parse_scene_metadata(stderr, 1_200_000);
        assert_eq!(points, vec![(0, 0.0), (240_000, 0.42), (720_000, 0.75)]);
        let scenes = build_scenes(&points, 1_200_000);
        assert_eq!(scenes.len(), 3);
        assert_eq!(scenes[1].start_tick, scenes[0].end_tick);
        assert_eq!(scenes[2].end_tick, 1_200_000);
    }

    #[test]
    fn groups_tesseract_words_into_normalized_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n1\t1\t0\t0\t0\t0\t0\t0\t640\t360\t-1\t\n5\t1\t1\t1\t1\t1\t64\t36\t100\t30\t90\tValor\n5\t1\t1\t1\t1\t2\t174\t36\t80\t30\t80\t100";
        let lines = parse_tesseract_tsv(tsv);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Valor 100");
        assert!((lines[0].rect.x - 0.1).abs() < 0.001);
        assert!((lines[0].confidence - 0.85).abs() < 0.001);
    }

    #[test]
    fn links_matching_objects_across_adjacent_scenes() {
        let mut scenes = build_scenes(&[(0, 0.0), (100, 0.4)], 200);
        for (index, scene) in scenes.iter_mut().enumerate() {
            scene.observations.push(VisualObservation {
                id: format!("o{index}"), kind: "object".into(), label: "phone".into(), text: None, confidence: 0.9,
                rect: NormalizedRect { x: 0.1 + index as f64 * 0.01, y: 0.1, width: 0.2, height: 0.2 },
                start_tick: scene.start_tick, end_tick: scene.end_tick, track_id: None,
            });
        }
        link_object_tracks(&mut scenes);
        assert_eq!(scenes[0].observations[0].track_id, scenes[1].observations[0].track_id);
    }
}
