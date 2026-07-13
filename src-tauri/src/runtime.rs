use crate::error::AppError;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;
use tokio::process::Command;

pub fn ffmpeg_binary() -> PathBuf {
    std::env::var_os("FFMPEG_PATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("ffmpeg"))
}

pub fn ffprobe_binary() -> PathBuf {
    std::env::var_os("FFPROBE_PATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("ffprobe"))
}

pub fn whisper_binary() -> PathBuf {
    std::env::var_os("WHISPER_CLI_PATH").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("whisper-cli"))
}

pub fn ytdlp_binary(app: &tauri::AppHandle) -> PathBuf {
    if let Some(path) = std::env::var_os("YTDLP_PATH") { return PathBuf::from(path); }
    let executable_name = if cfg!(target_os = "windows") { "yt-dlp.exe" } else { "yt-dlp" };
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            let candidate = directory.join(executable_name);
            if candidate.is_file() { return candidate; }
        }
    }
    if let Ok(directory) = app.path().resource_dir() {
        for candidate in [directory.join(executable_name), directory.join("binaries").join(executable_name)] {
            if candidate.is_file() { return candidate; }
        }
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/yt-dlp-x86_64-unknown-linux-gnu");
        if candidate.is_file() { return candidate; }
    }
    PathBuf::from("yt-dlp")
}

pub fn resolve_whisper_model(requested: Option<&str>) -> Result<PathBuf, AppError> {
    if let Some(path) = requested.map(str::trim).filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path).ok_or_else(|| AppError::new("WHISPER_MODEL_MISSING", "O modelo selecionado não foi encontrado"));
    }
    if let Ok(path) = std::env::var("WHISPER_MODEL_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() { return Ok(path); }
    }
    let candidates = [
        PathBuf::from("models/ggml-large-v3-turbo-q5_0.bin"),
        PathBuf::from("../models/ggml-large-v3-turbo-q5_0.bin"),
    ];
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| AppError::new("WHISPER_MODEL_MISSING", "Selecione um modelo .bin ou configure WHISPER_MODEL_PATH"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    available: bool,
    detail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    ffmpeg: DependencyStatus,
    ffprobe: DependencyStatus,
    whisper: DependencyStatus,
    model: DependencyStatus,
    youtube: DependencyStatus,
}

async fn dependency(binary: PathBuf, version_arg: &str) -> DependencyStatus {
    match Command::new(&binary).arg(version_arg).output().await {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            DependencyStatus { available: true, detail: text.lines().next().unwrap_or("disponível").to_string() }
        }
        Ok(output) => DependencyStatus { available: false, detail: String::from_utf8_lossy(&output.stderr).lines().next().unwrap_or("falha ao executar").to_string() },
        Err(error) => DependencyStatus { available: false, detail: error.to_string() },
    }
}

#[tauri::command]
pub async fn runtime_status(model_path: Option<String>, app: tauri::AppHandle) -> RuntimeStatus {
    let (ffmpeg, ffprobe, whisper, ytdlp, node) = tokio::join!(
        dependency(ffmpeg_binary(), "-version"),
        dependency(ffprobe_binary(), "-version"),
        dependency(whisper_binary(), "--help"),
        dependency(ytdlp_binary(&app), "--version"),
        dependency(PathBuf::from("node"), "--version"),
    );
    let youtube = if ytdlp.available && node.available {
        DependencyStatus { available: true, detail: format!("yt-dlp · {}", node.detail) }
    } else {
        DependencyStatus { available: false, detail: format!("yt-dlp: {} · Node 22+: {}", ytdlp.detail, node.detail) }
    };
    let model = match resolve_whisper_model(model_path.as_deref()) {
        Ok(path) => DependencyStatus { available: true, detail: path.to_string_lossy().into_owned() },
        Err(error) => DependencyStatus { available: false, detail: error.message },
    };
    RuntimeStatus { ffmpeg, ffprobe, whisper, model, youtube }
}
