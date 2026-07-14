use crate::error::AppError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{io::{Read, Write}, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};
use tauri::Manager;
use tokio::io::AsyncReadExt;

const MODEL_SOURCE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const MODEL_USER_AGENT: &str = "AI-Video-Editor/1.0 (local-whisper-model)";
// Model downloads and validation run on Tokio worker threads. Keep I/O buffers on
// the heap so a large buffer cannot exhaust a worker's comparatively small stack.
const MODEL_IO_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelInfo {
    pub id: String,
    pub filename: String,
    pub label: String,
    pub detail: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelStatus {
    pub info: WhisperModelInfo,
    pub path: String,
    pub downloaded: bool,
    pub verified: bool,
    pub active: bool,
}

#[derive(Default)]
pub struct ModelDownloadState {
    cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ModelDefinition {
    id: &'static str,
    label: &'static str,
    detail: &'static str,
    size_bytes: u64,
    sha256: &'static str,
    recommended: bool,
}

const MODEL_DEFINITIONS: [ModelDefinition; 4] = [
    ModelDefinition { id: "tiny", label: "Tiny", detail: "Mais rápido · menor precisão", size_bytes: 77_691_713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", recommended: false },
    ModelDefinition { id: "base", label: "Base", detail: "Equilíbrio para máquinas modestas", size_bytes: 147_951_465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", recommended: false },
    ModelDefinition { id: "small", label: "Small", detail: "Mais precisão · mais lento", size_bytes: 487_601_967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", recommended: false },
    ModelDefinition { id: "large-v3-turbo-q5_0", label: "Large v3 Turbo Q5", detail: "Recomendado · multilíngue · 547 MiB", size_bytes: 574_041_195, sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2", recommended: true },
];

fn definition(id: &str) -> Result<ModelDefinition, AppError> {
    MODEL_DEFINITIONS.iter().find(|item| item.id == id).cloned().ok_or_else(|| AppError::new("WHISPER_MODEL_UNKNOWN", "Modelo Whisper não reconhecido"))
}

fn info(definition: &ModelDefinition) -> WhisperModelInfo {
    WhisperModelInfo {
        id: definition.id.into(),
        filename: format!("ggml-{}.bin", definition.id),
        label: definition.label.into(),
        detail: definition.detail.into(),
        size_bytes: definition.size_bytes,
        sha256: definition.sha256.into(),
        recommended: definition.recommended,
    }
}

fn model_directory(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(app.path().app_data_dir().map_err(|error| AppError::new("APP_DATA_PATH", error.to_string()))?.join("models"))
}

fn model_path(app: &tauri::AppHandle, definition: &ModelDefinition) -> Result<PathBuf, AppError> {
    Ok(model_directory(app)?.join(format!("ggml-{}.bin", definition.id)))
}

fn marker_path(path: &Path) -> PathBuf {
    path.with_extension("bin.sha256")
}

fn active_marker(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(model_directory(app)?.join("active-model"))
}

fn read_active_id(app: &tauri::AppHandle) -> Option<String> {
    std::fs::read_to_string(active_marker(app).ok()?).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

fn verified_marker(path: &Path, expected: &str) -> bool {
    std::fs::read_to_string(marker_path(path)).ok().is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
}

async fn digest_file(path: &Path) -> Result<String, AppError> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; MODEL_IO_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn model_urls(definition: &ModelDefinition) -> [String; 3] {
    let filename = format!("ggml-{}.bin", definition.id);
    [
        format!("{MODEL_SOURCE}/{filename}?download=1&disable_xet=true"),
        format!("{MODEL_SOURCE}/{filename}?download=1"),
        format!("{MODEL_SOURCE}/{filename}"),
    ]
}

fn open_model_response(client: &reqwest::blocking::Client, definition: &ModelDefinition) -> Result<reqwest::blocking::Response, AppError> {
    let mut last_status = None;
    for url in model_urls(definition) {
        for attempt in 0..3u32 {
            let response = client.get(&url)
                .header(reqwest::header::ACCEPT, "application/octet-stream")
                .send()
                .map_err(|error| AppError::retryable("WHISPER_MODEL_DOWNLOAD_FAILED", error.to_string()))?;
            if response.status().is_success() { return Ok(response); }
            let status = response.status();
            last_status = Some(status);
            if !(status == reqwest::StatusCode::FORBIDDEN || status.is_server_error()) { break; }
            if attempt < 2 { std::thread::sleep(Duration::from_millis(300 * 2u64.pow(attempt))); }
        }
    }
    let status = last_status.map(|value| value.to_string()).unwrap_or_else(|| "desconhecido".into());
    Err(AppError::retryable("WHISPER_MODEL_DOWNLOAD_FAILED", format!("Hugging Face recusou o download (HTTP {status}). Tente novamente em alguns segundos.")))
}

fn digest_file_sync(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; MODEL_IO_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn download_model_blocking(definition: ModelDefinition, destination: PathBuf, temporary: PathBuf, cancel: Arc<AtomicBool>) -> Result<String, AppError> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(MODEL_USER_AGENT)
        .build()
        .map_err(|error| AppError::retryable("WHISPER_MODEL_DOWNLOAD_FAILED", error.to_string()))?;
    let mut response = open_model_response(&client, &definition)?;
    let mut file = std::fs::File::create(&temporary)?;
    let mut buffer = vec![0u8; MODEL_IO_BUFFER_BYTES];
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(AppError::retryable("WHISPER_MODEL_CANCELLED", "Download cancelado"));
        }
        let read = response.read(&mut buffer).map_err(|error| AppError::retryable("WHISPER_MODEL_DOWNLOAD_FAILED", error.to_string()))?;
        if read == 0 { break; }
        file.write_all(&buffer[..read])?;
    }
    file.flush()?;
    drop(file);
    let actual_size = std::fs::metadata(&temporary)?.len();
    if actual_size != definition.size_bytes {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::new("WHISPER_MODEL_INVALID", "O download terminou com tamanho inesperado"));
    }
    let digest = digest_file_sync(&temporary)?;
    if !digest.eq_ignore_ascii_case(definition.sha256) {
        let _ = std::fs::remove_file(&temporary);
        return Err(AppError::new("WHISPER_MODEL_INVALID", "O modelo baixado não passou na validação de integridade"));
    }
    std::fs::rename(&temporary, &destination)?;
    Ok(digest)
}

async fn mark_verified(path: &Path, digest: &str) -> Result<(), AppError> {
    tokio::fs::write(marker_path(path), format!("{digest}\n")).await?;
    Ok(())
}

pub fn catalog() -> Vec<WhisperModelInfo> {
    MODEL_DEFINITIONS.iter().map(info).collect()
}

pub async fn statuses(app: &tauri::AppHandle) -> Result<Vec<WhisperModelStatus>, AppError> {
    let active = read_active_id(app);
    let mut result = Vec::with_capacity(MODEL_DEFINITIONS.len());
    for definition in MODEL_DEFINITIONS.iter() {
        let path = model_path(app, definition)?;
        let downloaded = tokio::fs::metadata(&path).await.map(|metadata| metadata.len() == definition.size_bytes).unwrap_or(false);
        result.push(WhisperModelStatus { info: info(definition), path: path.to_string_lossy().into_owned(), downloaded, verified: downloaded && verified_marker(&path, definition.sha256), active: active.as_deref() == Some(definition.id) });
    }
    Ok(result)
}

pub fn active_model_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let id = read_active_id(app)?;
    let definition = definition(&id).ok()?;
    let path = model_path(app, &definition).ok()?;
    (path.is_file() && verified_marker(&path, definition.sha256)).then_some(path)
}

#[tauri::command]
pub fn model_catalog() -> Vec<WhisperModelInfo> {
    catalog()
}

#[tauri::command]
pub async fn model_status(app: tauri::AppHandle) -> Result<Vec<WhisperModelStatus>, AppError> {
    statuses(&app).await
}

#[tauri::command]
pub async fn model_activate(model_id: String, app: tauri::AppHandle) -> Result<WhisperModelStatus, AppError> {
    activate_definition(&definition(&model_id)?, &app).await
}

async fn activate_definition(definition: &ModelDefinition, app: &tauri::AppHandle) -> Result<WhisperModelStatus, AppError> {
    let path = model_path(app, definition)?;
    if !path.is_file() { return Err(AppError::new("WHISPER_MODEL_MISSING", "Baixe o modelo antes de ativá-lo")); }
    let digest = digest_file(&path).await?;
    if !digest.eq_ignore_ascii_case(definition.sha256) { return Err(AppError::new("WHISPER_MODEL_INVALID", "O arquivo do modelo não passou na validação de integridade")); }
    mark_verified(&path, &digest).await?;
    tokio::fs::create_dir_all(model_directory(app)?).await?;
    tokio::fs::write(active_marker(app)?, format!("{}\n", definition.id)).await?;
    statuses(app).await?.into_iter().find(|item| item.info.id == definition.id).ok_or_else(|| AppError::new("WHISPER_MODEL_UNKNOWN", "Modelo Whisper não reconhecido"))
}

#[tauri::command]
pub async fn model_download(model_id: String, app: tauri::AppHandle, state: tauri::State<'_, ModelDownloadState>) -> Result<WhisperModelStatus, AppError> {
    let definition = definition(&model_id)?;
    let directory = model_directory(&app)?;
    tokio::fs::create_dir_all(&directory).await?;
    let destination = model_path(&app, &definition)?;
    if destination.is_file() && verified_marker(&destination, definition.sha256) {
        tokio::fs::write(active_marker(&app)?, format!("{}\n", definition.id)).await?;
        return Ok(WhisperModelStatus { info: info(&definition), path: destination.to_string_lossy().into_owned(), downloaded: true, verified: true, active: true });
    }
    state.cancel.store(false, Ordering::SeqCst);
    let temporary = destination.with_extension("bin.part");
    let cancel = state.cancel.clone();
    let download_definition = definition.clone();
    let digest = tokio::task::spawn_blocking(move || download_model_blocking(download_definition, destination, temporary, cancel))
        .await
        .map_err(|error| AppError::retryable("WHISPER_MODEL_DOWNLOAD_FAILED", error.to_string()))??;
    mark_verified(&model_path(&app, &definition)?, &digest).await?;
    tokio::fs::write(active_marker(&app)?, format!("{}\n", definition.id)).await?;
    let path = model_path(&app, &definition)?;
    Ok(WhisperModelStatus { info: info(&definition), path: path.to_string_lossy().into_owned(), downloaded: true, verified: true, active: true })
}

#[tauri::command]
pub fn model_cancel_download(state: tauri::State<'_, ModelDownloadState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn model_delete(model_id: String, app: tauri::AppHandle) -> Result<(), AppError> {
    let definition = definition(&model_id)?;
    if read_active_id(&app).as_deref() == Some(definition.id) { return Err(AppError::new("WHISPER_MODEL_ACTIVE", "Ative outro modelo antes de removê-lo")); }
    let path = model_path(&app, &definition)?;
    let _ = tokio::fs::remove_file(&path).await;
    let _ = tokio::fs::remove_file(marker_path(&path)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_uses_pinned_multilingual_models() {
        assert_eq!(MODEL_DEFINITIONS.len(), 4);
        assert!(MODEL_DEFINITIONS.iter().any(|item| item.recommended && item.id == "large-v3-turbo-q5_0"));
        assert!(MODEL_DEFINITIONS.iter().all(|item| item.sha256.len() == 64 && item.size_bytes > 0));
        assert!(MODEL_DEFINITIONS.iter().all(|item| !item.id.ends_with(".en")));
    }

    #[test]
    fn catalog_rejects_unknown_model_ids() {
        assert!(definition("unknown").is_err());
        assert_eq!(definition("base").unwrap().label, "Base");
    }

    #[test]
    fn download_urls_keep_official_hugging_face_fallbacks() {
        let urls = model_urls(&definition("tiny").unwrap());
        assert!(urls[0].starts_with(MODEL_SOURCE));
        assert!(urls[0].contains("download=1&disable_xet=true"));
        assert!(urls.iter().all(|url| url.contains("ggml-tiny.bin")));
    }
}
