use crate::{
    domain::{Transcript, TranscriptSegment, TranscriptWord, TICKS_PER_SECOND},
    error::AppError,
    media::probe_path,
    runtime::{ffmpeg_binary, resolve_whisper_model, whisper_binary},
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionRequest {
    pub asset_id: String,
    pub media_path: String,
    pub model_path: Option<String>,
    pub language: Option<String>,
}

fn parse_clock(value: &str) -> i64 {
    let seconds = value.trim().split(':').filter_map(|part| part.parse::<f64>().ok()).fold(0.0, |total, part| total * 60.0 + part);
    (seconds * TICKS_PER_SECOND as f64).round() as i64
}

fn value_tick(value: &Value, edge: &str) -> Option<i64> {
    value.get("offsets").and_then(|offsets| offsets.get(edge)).and_then(Value::as_i64).map(|milliseconds| milliseconds * TICKS_PER_SECOND / 1000)
        .or_else(|| value.get("timestamps").and_then(|timestamps| timestamps.get(edge)).and_then(Value::as_str).map(parse_clock))
        .or_else(|| value.get(edge).and_then(Value::as_f64).map(|seconds| (seconds * TICKS_PER_SECOND as f64).round() as i64))
}

fn parse_words(segment: &Value) -> Option<Vec<TranscriptWord>> {
    let values = segment.get("words").or_else(|| segment.get("tokens"))?.as_array()?;
    let words = values.iter().filter_map(|word| {
        let text = word.get("text").or_else(|| word.get("word")).and_then(Value::as_str)?.trim().to_string();
        if text.is_empty() { return None; }
        Some(TranscriptWord {
            text,
            start_tick: value_tick(word, "from").or_else(|| value_tick(word, "start")).unwrap_or_default(),
            end_tick: value_tick(word, "to").or_else(|| value_tick(word, "end")).unwrap_or_default(),
            confidence: word.get("p").or_else(|| word.get("probability")).and_then(Value::as_f64),
        })
    }).collect::<Vec<_>>();
    (!words.is_empty()).then_some(words)
}

pub fn parse_whisper_json(json: &Value, asset_id: &str, model: &str, fingerprint: Option<String>) -> Result<Transcript, AppError> {
    let language = json.get("result").and_then(|value| value.get("language")).and_then(Value::as_str)
        .or_else(|| json.get("language").and_then(Value::as_str)).map(str::to_owned);
    let values = json.get("transcription").or_else(|| json.get("segments")).and_then(Value::as_array)
        .ok_or_else(|| AppError::new("TRANSCRIPT_FORMAT", "A saída do whisper.cpp não contém segmentos"))?;
    let mut segments = Vec::new();
    for value in values {
        let text = value.get("text").and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if text.is_empty() { continue; }
        let start_tick = value_tick(value, "from").or_else(|| value_tick(value, "start")).unwrap_or_default().max(0);
        let end_tick = value_tick(value, "to").or_else(|| value_tick(value, "end")).unwrap_or(start_tick + 1).max(start_tick + 1);
        segments.push(TranscriptSegment {
            id: format!("segment-{}", Uuid::new_v4()),
            start_tick,
            end_tick,
            text,
            language: language.clone(),
            speaker: None,
            words: parse_words(value),
            confidence: value.get("avg_logprob").and_then(Value::as_f64).map(f64::exp),
        });
    }
    segments.sort_by_key(|segment| segment.start_tick);
    Ok(Transcript { asset_id: asset_id.to_string(), engine: "whisper.cpp".into(), model: model.into(), source_fingerprint: fingerprint, language, segments })
}

async fn ensure_success(command: &str, output: std::process::Output, code: &str) -> Result<(), AppError> {
    if output.status.success() { return Ok(()); }
    Err(AppError::new(code, format!("{command}: {}", String::from_utf8_lossy(&output.stderr).trim())))
}

#[tauri::command]
pub async fn transcription_start(request: TranscriptionRequest) -> Result<Transcript, AppError> {
    let media = tokio::fs::canonicalize(&request.media_path).await.map_err(|_| AppError::new("MEDIA_NOT_FOUND", "A mídia para transcrição não foi encontrada"))?;
    let model = resolve_whisper_model(request.model_path.as_deref())?;
    let probe = probe_path(media.to_string_lossy().as_ref()).await?;
    if !probe.has_audio { return Err(AppError::new("NO_AUDIO", "O arquivo não possui uma faixa de áudio")); }

    let run_id = Uuid::new_v4();
    let wav_path = std::env::temp_dir().join(format!("ai-video-editor-{run_id}.wav"));
    let output_prefix = std::env::temp_dir().join(format!("ai-video-editor-{run_id}-transcript"));
    let ffmpeg = Command::new(ffmpeg_binary())
        .arg("-v").arg("error").arg("-y").arg("-i").arg(&media)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(&wav_path).output().await
        .map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível iniciar FFmpeg: {error}")))?;
    if let Err(error) = ensure_success("FFmpeg", ffmpeg, "AUDIO_EXTRACTION_FAILED").await {
        let _ = tokio::fs::remove_file(&wav_path).await;
        return Err(error);
    }

    let mut command = Command::new(whisper_binary());
    command.arg("-m").arg(&model).arg("-f").arg(&wav_path).arg("-oj").arg("-of").arg(&output_prefix);
    if let Some(language) = request.language.as_deref() { command.arg("-l").arg(language); }
    let whisper = command.output().await;
    let _ = tokio::fs::remove_file(&wav_path).await;
    let whisper = whisper.map_err(|error| AppError::new("WHISPER_NOT_FOUND", format!("Não foi possível iniciar whisper.cpp: {error}")))?;
    ensure_success("whisper.cpp", whisper, "TRANSCRIPTION_FAILED").await?;

    let json_path = PathBuf::from(format!("{}.json", output_prefix.display()));
    let data = tokio::fs::read(&json_path).await;
    let _ = tokio::fs::remove_file(&json_path).await;
    let data = data.map_err(|_| AppError::new("TRANSCRIPT_MISSING", "whisper.cpp terminou sem gerar JSON"))?;
    let value: Value = serde_json::from_slice(&data)?;
    let model_name = model.file_name().and_then(|value| value.to_str()).unwrap_or("whisper-model");
    parse_whisper_json(&value, &request.asset_id, model_name, probe.fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_whisper_segments_to_ticks() {
        let value = json!({
            "result": {"language": "pt"},
            "transcription": [{
                "timestamps": {"from": "00:00:01.000", "to": "00:00:02.500"},
                "text": " teste local "
            }]
        });
        let transcript = parse_whisper_json(&value, "asset", "model", Some("hash".into())).unwrap();
        assert_eq!(transcript.segments[0].start_tick, TICKS_PER_SECOND);
        assert_eq!(transcript.segments[0].end_tick, TICKS_PER_SECOND * 5 / 2);
        assert_eq!(transcript.segments[0].text, "teste local");
    }
}
