use crate::{domain::{MediaAsset, TICKS_PER_SECOND}, error::AppError, runtime::{ffmpeg_binary, ffprobe_binary, ytdlp_binary}};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, time::UNIX_EPOCH};
use tauri::Manager;
use tokio::process::Command;
use uuid::Uuid;

pub(crate) fn allow_asset_file(app: &tauri::AppHandle, path: &Path) -> Result<(), AppError> {
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|error| AppError::new("ASSET_SCOPE", format!("Não foi possível liberar a mídia para o monitor: {error}")))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub duration_ticks: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub codec: Option<String>,
    pub has_audio: bool,
    pub fingerprint: Option<String>,
}

fn parse_fraction(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator: f64 = numerator.parse().ok()?;
    let denominator: f64 = denominator.parse().ok()?;
    if denominator == 0.0 { None } else { Some(numerator / denominator) }
}

async fn fingerprint(path: &Path) -> Result<String, AppError> {
    let metadata = tokio::fs::metadata(path).await?;
    let modified = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_secs()).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    Ok(hex::encode(hasher.finalize()))
}

pub async fn probe_path(path: &str) -> Result<MediaProbe, AppError> {
    let canonical = tokio::fs::canonicalize(path).await.map_err(|_| AppError::new("MEDIA_NOT_FOUND", "O arquivo de mídia não foi encontrado"))?;
    if !canonical.is_file() { return Err(AppError::new("INVALID_MEDIA", "O caminho selecionado não é um arquivo")); }
    let output = Command::new(ffprobe_binary())
        .args(["-v", "error", "-show_streams", "-show_format", "-of", "json"])
        .arg(&canonical)
        .output()
        .await
        .map_err(|error| AppError::new("FFPROBE_NOT_FOUND", format!("Não foi possível iniciar ffprobe: {error}")))?;
    if !output.status.success() {
        return Err(AppError::new("MEDIA_PROBE_FAILED", String::from_utf8_lossy(&output.stderr).trim().to_string()));
    }
    let json: Value = serde_json::from_slice(&output.stdout)?;
    let streams = json.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let video = streams.iter().find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let has_audio = streams.iter().any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let duration = json.get("format").and_then(|value| value.get("duration")).and_then(Value::as_str).and_then(|value| value.parse::<f64>().ok())
        .or_else(|| streams.iter().filter_map(|stream| stream.get("duration").and_then(Value::as_str).and_then(|value| value.parse::<f64>().ok())).fold(None, |max, value| Some(max.unwrap_or(value).max(value))))
        .unwrap_or(0.0);
    let width = video.and_then(|value| value.get("width")).and_then(Value::as_u64).map(|value| value as u32);
    let height = video.and_then(|value| value.get("height")).and_then(Value::as_u64).map(|value| value as u32);
    let fps = video.and_then(|value| value.get("avg_frame_rate")).and_then(Value::as_str).and_then(parse_fraction);
    let codec = video.and_then(|value| value.get("codec_name")).and_then(Value::as_str).map(str::to_owned)
        .or_else(|| streams.first().and_then(|value| value.get("codec_name")).and_then(Value::as_str).map(str::to_owned));
    Ok(MediaProbe {
        duration_ticks: (duration * TICKS_PER_SECOND as f64).round() as i64,
        width,
        height,
        fps,
        codec,
        has_audio,
        fingerprint: Some(fingerprint(&canonical).await?),
    })
}

async fn extract_waveform(path: &Path) -> Option<Vec<f32>> {
    let output = Command::new(ffmpeg_binary())
        .args(["-v", "error", "-i"]).arg(path)
        .args(["-vn", "-ac", "1", "-ar", "400", "-f", "f32le", "pipe:1"])
        .output().await.ok()?;
    if !output.status.success() { return None; }
    let samples = output.stdout.chunks_exact(4).map(|bytes| f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]).abs()).collect::<Vec<_>>();
    if samples.is_empty() { return None; }
    let bucket_count = 768usize.min(samples.len());
    let bucket_size = samples.len().div_ceil(bucket_count);
    Some(samples.chunks(bucket_size).map(|bucket| bucket.iter().copied().fold(0.0f32, f32::max).clamp(0.0, 1.0)).collect())
}

fn validate_youtube_url(value: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| AppError::new("INVALID_URL", "Informe uma URL válida do YouTube"))?;
    if url.scheme() != "https" { return Err(AppError::new("INVALID_URL", "A URL do YouTube deve usar HTTPS")); }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = host == "youtu.be" || host == "youtube.com" || host.ends_with(".youtube.com");
    if !allowed { return Err(AppError::new("UNSUPPORTED_URL", "Somente URLs do YouTube são aceitas")); }
    Ok(url.into())
}

async fn imported_asset(canonical: &Path, name: String, app: &tauri::AppHandle) -> Result<MediaAsset, AppError> {
    let probe = probe_path(canonical.to_string_lossy().as_ref()).await?;
    let waveform = if probe.has_audio { extract_waveform(canonical).await } else { None };
    allow_asset_file(app, canonical)?;
    Ok(MediaAsset {
        id: format!("asset-{}", Uuid::new_v4()),
        name,
        path: Some(canonical.to_string_lossy().to_string()),
        object_url: None,
        duration_ticks: probe.duration_ticks,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        codec: probe.codec,
        has_audio: probe.has_audio,
        fingerprint: probe.fingerprint,
        proxy_path: None,
        waveform,
        offline: false,
    })
}

#[tauri::command]
pub async fn media_probe(path: String) -> Result<MediaProbe, AppError> {
    probe_path(&path).await
}

#[tauri::command]
pub async fn media_import(path: String, name: String, app: tauri::AppHandle) -> Result<MediaAsset, AppError> {
    let canonical = tokio::fs::canonicalize(&path).await.map_err(|_| AppError::new("MEDIA_NOT_FOUND", "O arquivo de mídia não foi encontrado"))?;
    imported_asset(&canonical, name, &app).await
}

#[tauri::command]
pub async fn media_import_url(url: String, app: tauri::AppHandle) -> Result<MediaAsset, AppError> {
    let url = validate_youtube_url(&url)?;
    let directory = app.path().app_cache_dir().map_err(|error| AppError::new("CACHE_PATH", error.to_string()))?.join("youtube");
    tokio::fs::create_dir_all(&directory).await?;
    let output = Command::new(ytdlp_binary(&app))
        .args(["--ignore-config", "--no-playlist", "--no-progress", "--no-overwrites", "--windows-filenames", "--js-runtimes", "node", "--print", "after_move:filepath", "--merge-output-format", "mp4", "-f", "bv*[height<=1080]+ba/b[height<=1080]"])
        .arg("-P").arg(&directory)
        .args(["-o", "%(title).120B [%(id)s].%(ext)s", "--"])
        .arg(&url)
        .output().await
        .map_err(|error| AppError::new("YTDLP_NOT_FOUND", format!("Não foi possível iniciar o importador do YouTube: {error}")))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).lines().rfind(|line| !line.trim().is_empty()).unwrap_or("Falha ao baixar o vídeo").to_string();
        return Err(AppError::retryable("YOUTUBE_DOWNLOAD_FAILED", detail));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reported = stdout.lines().rfind(|line| !line.trim().is_empty()).map(str::trim).ok_or_else(|| AppError::new("YOUTUBE_OUTPUT_MISSING", "O download terminou sem informar o arquivo gerado"))?;
    let canonical = tokio::fs::canonicalize(reported).await.map_err(|_| AppError::new("YOUTUBE_OUTPUT_MISSING", "O arquivo baixado não foi encontrado"))?;
    let canonical_directory = tokio::fs::canonicalize(&directory).await?;
    if !canonical.starts_with(&canonical_directory) { return Err(AppError::new("YOUTUBE_OUTPUT_INVALID", "O importador retornou um caminho fora do cache permitido")); }
    let name = canonical.file_name().and_then(|value| value.to_str()).unwrap_or("Vídeo do YouTube").to_string();
    imported_asset(&canonical, name, &app).await
}

#[tauri::command]
pub async fn media_proxy(path: String, fingerprint: Option<String>, app: tauri::AppHandle) -> Result<String, AppError> {
    let source = tokio::fs::canonicalize(path).await.map_err(|_| AppError::new("MEDIA_NOT_FOUND", "A mídia para proxy não foi encontrada"))?;
    let directory = app.path().app_cache_dir().map_err(|error| AppError::new("CACHE_PATH", error.to_string()))?.join("proxies");
    tokio::fs::create_dir_all(&directory).await?;
    let key = fingerprint.unwrap_or_else(|| Uuid::new_v4().to_string());
    let output_path = directory.join(format!("{key}.proxy-v2.webm"));
    if output_path.is_file() {
        allow_asset_file(&app, &output_path)?;
        return Ok(output_path.to_string_lossy().into_owned());
    }
    let temp_path = directory.join(format!("{key}.{}.tmp.webm", Uuid::new_v4()));
    let webm = Command::new(ffmpeg_binary())
        .args(["-hide_banner", "-v", "error", "-y", "-i"]).arg(&source)
        .args(["-vf", "scale=-2:720:force_original_aspect_ratio=decrease", "-c:v", "libvpx", "-deadline", "good", "-cpu-used", "4", "-crf", "31", "-b:v", "0", "-c:a", "libopus", "-b:a", "96k"])
        .arg(&temp_path).output().await
        .map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível iniciar FFmpeg: {error}")))?;
    if webm.status.success() {
        tokio::fs::rename(&temp_path, &output_path).await?;
        allow_asset_file(&app, &output_path)?;
        return Ok(output_path.to_string_lossy().into_owned());
    }
    let webm_error = String::from_utf8_lossy(&webm.stderr).trim().to_string();
    let _ = tokio::fs::remove_file(&temp_path).await;

    let fallback_path = directory.join(format!("{key}.proxy-v2.mp4"));
    if fallback_path.is_file() {
        allow_asset_file(&app, &fallback_path)?;
        return Ok(fallback_path.to_string_lossy().into_owned());
    }
    let fallback_temp = directory.join(format!("{key}.{}.tmp.mp4", Uuid::new_v4()));
    let mp4 = Command::new(ffmpeg_binary())
        .args(["-hide_banner", "-v", "error", "-y", "-i"]).arg(&source)
        .args(["-vf", "scale=-2:720:force_original_aspect_ratio=decrease", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
        .arg(&fallback_temp).output().await
        .map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível iniciar FFmpeg: {error}")))?;
    if !mp4.status.success() {
        let mp4_error = String::from_utf8_lossy(&mp4.stderr).trim().to_string();
        let _ = tokio::fs::remove_file(&fallback_temp).await;
        return Err(AppError::new("PROXY_FAILED", format!("WebM: {webm_error}\nMP4: {mp4_error}")));
    }
    if let Err(error) = tokio::fs::rename(&fallback_temp, &fallback_path).await {
        let _ = tokio::fs::remove_file(&fallback_temp).await;
        return Err(error.into());
    }
    allow_asset_file(&app, &fallback_path)?;
    Ok(fallback_path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ntsc_fraction() {
        assert!((parse_fraction("30000/1001").unwrap() - 29.97002997).abs() < 0.0001);
        assert!(parse_fraction("1/0").is_none());
    }

    #[test]
    fn accepts_only_https_youtube_urls() {
        assert!(validate_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("https://youtu.be/dQw4w9WgXcQ").is_ok());
        assert!(validate_youtube_url("http://youtube.com/watch?v=x").is_err());
        assert!(validate_youtube_url("https://youtube.com.example.test/watch?v=x").is_err());
    }
}
