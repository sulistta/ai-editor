use crate::{
    domain::{AppState, EditorProject, TimelineClip},
    error::AppError,
    runtime::ffmpeg_binary,
};
use std::{path::{Path, PathBuf}, process::Stdio, sync::atomic::Ordering};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

struct RenderInput<'a> {
    path: &'a str,
    clip: &'a TimelineClip,
    video: bool,
    audio: bool,
}

struct RenderPlan {
    inputs: Vec<String>,
    filter_complex: String,
}

fn tick_seconds(tick: i64, timebase: i64) -> f64 {
    tick as f64 / timebase as f64
}

fn project_duration(project: &EditorProject) -> Result<i64, AppError> {
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let duration = sequence.tracks.iter().flat_map(|track| track.clips.iter()).map(|clip| clip.start_tick + clip.duration_ticks).max().unwrap_or(0);
    if duration <= 0 { return Err(AppError::new("EMPTY_SEQUENCE", "Não há clipes para exportar")); }
    Ok(duration)
}

fn collect_inputs(project: &EditorProject) -> Result<Vec<RenderInput<'_>>, AppError> {
    let sequence = project.active_sequence().ok_or_else(|| AppError::new("SEQUENCE_NOT_FOUND", "Sequência ativa não encontrada"))?;
    let mut inputs = Vec::new();
    for track in &sequence.tracks {
        for clip in &track.clips {
            let asset = project.assets.iter().find(|asset| asset.id == clip.asset_id).ok_or_else(|| AppError::new("ASSET_NOT_FOUND", format!("Asset ausente para {}", clip.name)))?;
            let path = asset.path.as_deref().ok_or_else(|| AppError::new("ASSET_PATH_MISSING", format!("{} não possui caminho local", asset.name)))?;
            if !Path::new(path).is_file() { return Err(AppError::new("ASSET_OFFLINE", format!("Arquivo offline: {}", asset.name))); }
            let video = track.kind == "video" && !track.hidden && asset.width.is_some() && asset.height.is_some();
            let audio = matches!(track.kind.as_str(), "video" | "audio") && !track.muted && asset.has_audio;
            if video || audio { inputs.push(RenderInput { path, clip, video, audio }); }
        }
    }
    Ok(inputs)
}

fn atempo_filters(speed: f64) -> Vec<String> {
    let mut remaining = speed.clamp(0.05, 20.0);
    let mut filters = Vec::new();
    while remaining > 2.0 {
        filters.push("atempo=2.0".into());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        filters.push("atempo=0.5".into());
        remaining /= 0.5;
    }
    filters.push(format!("atempo={remaining:.6}"));
    filters
}

fn filter_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

fn effect_filters(clip: &TimelineClip) -> Vec<String> {
    let mut filters = Vec::new();
    for effect in clip.effects.iter().filter(|effect| effect.enabled) {
        match effect.kind.as_str() {
            "exposure" => filters.push(format!("eq=brightness={:.4}", effect.value.clamp(-1.0, 1.0))),
            "contrast" => filters.push(format!("eq=contrast={:.4}", (1.0 + effect.value).clamp(0.0, 2.0))),
            "saturation" => filters.push(format!("eq=saturation={:.4}", (1.0 + effect.value).clamp(0.0, 3.0))),
            "temperature" => {
                let shift = effect.value.clamp(-1.0, 1.0) * 0.25;
                filters.push(format!("colorbalance=rs={shift:.4}:bs={:.4}", -shift));
            }
            "chromaKey" => filters.push(format!("chromakey=0x00ff00:{:.4}:0.08", effect.value.abs().clamp(0.01, 1.0))),
            "blur" => filters.push(format!("gblur=sigma={:.4}", effect.value.abs() * 20.0)),
            _ => {}
        }
    }
    filters
}

fn fade_filters(clip: &TimelineClip, timebase: i64) -> Vec<String> {
    let mut filters = Vec::new();
    if let Some(transition) = &clip.transition_in {
        if transition.kind != "slide" {
            filters.push(format!("fade=t=in:st=0:d={:.6}:alpha=1", tick_seconds(transition.duration_ticks.min(clip.duration_ticks), timebase)));
        }
    }
    if let Some(transition) = &clip.transition_out {
        if transition.kind != "slide" {
            let duration = transition.duration_ticks.min(clip.duration_ticks);
            filters.push(format!("fade=t=out:st={:.6}:d={:.6}:alpha=1", tick_seconds(clip.duration_ticks - duration, timebase), tick_seconds(duration, timebase)));
        }
    }
    filters
}

fn overlay_x(clip: &TimelineClip, duration_tick: i64, timebase: i64) -> String {
    let base = format!("(W-w)/2+{:.3}", clip.transform.x);
    let start = tick_seconds(clip.start_tick, timebase);
    let end = tick_seconds(clip.start_tick + duration_tick, timebase);
    let transition_in = clip.transition_in.as_ref().filter(|transition| transition.kind == "slide");
    let transition_out = clip.transition_out.as_ref().filter(|transition| transition.kind == "slide");
    match (transition_in, transition_out) {
        (None, None) => base,
        (Some(input), None) => {
            let duration = tick_seconds(input.duration_ticks.min(duration_tick), timebase).max(0.001);
            format!("'{base}+if(between(t,{start:.6},{:.6}),({:.6}-t)/{duration:.6}*W,0)'", start + duration, start + duration)
        }
        (None, Some(output)) => {
            let duration = tick_seconds(output.duration_ticks.min(duration_tick), timebase).max(0.001);
            format!("'{base}+if(between(t,{:.6},{end:.6}),(t-{:.6})/{duration:.6}*W,0)'", end - duration, end - duration)
        }
        (Some(input), Some(output)) => {
            let in_duration = tick_seconds(input.duration_ticks.min(duration_tick), timebase).max(0.001);
            let out_duration = tick_seconds(output.duration_ticks.min(duration_tick), timebase).max(0.001);
            format!("'{base}+if(between(t,{start:.6},{:.6}),({:.6}-t)/{in_duration:.6}*W,if(between(t,{:.6},{end:.6}),(t-{:.6})/{out_duration:.6}*W,0))'", start + in_duration, start + in_duration, end - out_duration, end - out_duration)
        }
    }
}

fn build_render_plan(project: &EditorProject, subtitle_path: Option<&Path>) -> Result<RenderPlan, AppError> {
    let duration_tick = project_duration(project)?;
    let duration = tick_seconds(duration_tick, project.settings.timebase);
    let inputs = collect_inputs(project)?;
    let mut graph = Vec::new();
    let mut video_labels = Vec::new();
    let mut audio_labels = Vec::new();

    graph.push(format!(
        "color=c=black:s={}x{}:r={}/{}:d={duration:.6}[base]",
        project.settings.width, project.settings.height, project.settings.fps_num, project.settings.fps_den
    ));

    for (index, input) in inputs.iter().enumerate() {
        let clip = input.clip;
        let source_start = tick_seconds(clip.source_in_tick, project.settings.timebase);
        let source_duration = tick_seconds((clip.duration_ticks as f64 * clip.speed).round() as i64, project.settings.timebase);
        let timeline_start = tick_seconds(clip.start_tick, project.settings.timebase);
        if input.video {
            let crop_width = (1.0 - clip.transform.crop_left - clip.transform.crop_right).clamp(0.02, 1.0);
            let crop_height = (1.0 - clip.transform.crop_top - clip.transform.crop_bottom).clamp(0.02, 1.0);
            let mut filters = vec![
                format!("trim=start={source_start:.6}:duration={source_duration:.6}"),
                "setpts=PTS-STARTPTS".into(),
                format!("crop=iw*{crop_width:.6}:ih*{crop_height:.6}:iw*{:.6}:ih*{:.6}", clip.transform.crop_left.clamp(0.0, 0.98), clip.transform.crop_top.clamp(0.0, 0.98)),
            ];
            filters.extend(effect_filters(clip));
            let scale = clip.transform.scale.clamp(0.01, 10.0);
            filters.push(format!("scale=w={}*{scale:.6}:h={}*{scale:.6}:force_original_aspect_ratio=decrease", project.settings.width, project.settings.height));
            if clip.transform.rotation.abs() > 0.001 {
                let radians = clip.transform.rotation.to_radians();
                filters.push(format!("rotate={radians:.8}:ow=rotw({radians:.8}):oh=roth({radians:.8}):c=none"));
            }
            filters.push("format=rgba".into());
            filters.push(format!("colorchannelmixer=aa={:.6}", clip.transform.opacity.clamp(0.0, 1.0)));
            filters.extend(fade_filters(clip, project.settings.timebase));
            filters.push(format!("setpts=PTS/{:.6}+{timeline_start:.6}/TB", clip.speed.clamp(0.05, 20.0)));
            graph.push(format!("[{index}:v]{}[v{index}]", filters.join(",")));
            video_labels.push((index, overlay_x(clip, clip.duration_ticks, project.settings.timebase), clip.transform.y));
        }
        if input.audio {
            let mut filters = vec![
                format!("atrim=start={source_start:.6}:duration={source_duration:.6}"),
                "asetpts=PTS-STARTPTS".into(),
            ];
            filters.extend(atempo_filters(clip.speed));
            filters.push(format!("volume={:.6}", clip.volume.clamp(0.0, 4.0)));
            if let Some(transition) = &clip.transition_in {
                filters.push(format!("afade=t=in:st=0:d={:.6}", tick_seconds(transition.duration_ticks.min(clip.duration_ticks), project.settings.timebase)));
            }
            if let Some(transition) = &clip.transition_out {
                let fade_tick = transition.duration_ticks.min(clip.duration_ticks);
                filters.push(format!("afade=t=out:st={:.6}:d={:.6}", tick_seconds(clip.duration_ticks - fade_tick, project.settings.timebase), tick_seconds(fade_tick, project.settings.timebase)));
            }
            filters.push(format!("adelay={}:all=1", (timeline_start * 1000.0).round() as i64));
            graph.push(format!("[{index}:a]{}[a{index}]", filters.join(",")));
            audio_labels.push(format!("[a{index}]"));
        }
    }

    let mut video_output = "base".to_string();
    for (overlay_index, (input_index, x, y)) in video_labels.iter().enumerate() {
        let output = format!("overlay{overlay_index}");
        graph.push(format!("[{video_output}][v{input_index}]overlay=x={x}:y=(H-h)/2+{y:.3}:eof_action=pass:repeatlast=0:shortest=0[{output}]"));
        video_output = output;
    }
    if let Some(path) = subtitle_path {
        graph.push(format!("[{video_output}]subtitles=filename='{}':force_style='FontName=IBM Plex Mono,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=48'[vout]", filter_path(path)));
    } else {
        graph.push(format!("[{video_output}]null[vout]"));
    }

    if audio_labels.is_empty() {
        graph.push(format!("anullsrc=r={}:cl=stereo:d={duration:.6}[aout]", project.settings.sample_rate));
    } else {
        graph.push(format!("{}amix=inputs={}:normalize=0:duration=longest,atrim=duration={duration:.6},aresample={}[aout]", audio_labels.join(""), audio_labels.len(), project.settings.sample_rate));
    }

    Ok(RenderPlan { inputs: inputs.into_iter().map(|input| input.path.to_string()).collect(), filter_complex: graph.join(";") })
}

fn srt_timestamp(tick: i64, timebase: i64) -> String {
    let milliseconds = ((tick.max(0) as i128 * 1000) / timebase as i128) as i64;
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds / 60_000) % 60;
    let seconds = (milliseconds / 1000) % 60;
    let millis = milliseconds % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn subtitle_file(project: &EditorProject) -> Option<String> {
    let sequence = project.active_sequence()?;
    if sequence.captions.is_empty() { return None; }
    Some(sequence.captions.iter().enumerate().map(|(index, cue)| {
        let text = cue.text.replace(['\r', '\n'], " ");
        format!("{}\n{} --> {}\n{}\n", index + 1, srt_timestamp(cue.start_tick, project.settings.timebase), srt_timestamp(cue.end_tick, project.settings.timebase), text)
    }).collect::<Vec<_>>().join("\n"))
}

fn temporary_output(output_path: &Path) -> PathBuf {
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = output_path.file_stem().and_then(|value| value.to_str()).unwrap_or("export");
    parent.join(format!(".{stem}.{}.rendering.mp4", Uuid::new_v4()))
}

#[tauri::command]
pub fn render_cancel(state: tauri::State<'_, AppState>) {
    state.render_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn render_start(output_path: String, window: tauri::Window, state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    state.render_cancel.store(false, Ordering::Relaxed);
    let project = state.project.lock().map_err(|_| AppError::new("STATE_POISONED", "Estado do projeto indisponível"))?.clone();
    let duration_seconds = tick_seconds(project_duration(&project)?, project.settings.timebase).max(0.001);
    let run_id = Uuid::new_v4();
    let subtitle_path = subtitle_file(&project).map(|_| std::env::temp_dir().join(format!("ai-video-editor-{run_id}.srt")));
    if let (Some(path), Some(contents)) = (&subtitle_path, subtitle_file(&project)) { tokio::fs::write(path, contents).await?; }
    let plan = build_render_plan(&project, subtitle_path.as_deref())?;
    let output_path = PathBuf::from(output_path);
    let temp_output = temporary_output(&output_path);
    let mut command = Command::new(ffmpeg_binary());
    command.args(["-hide_banner", "-v", "error", "-y", "-progress", "pipe:1", "-nostats"]);
    for input in &plan.inputs { command.arg("-i").arg(input); }
    command.arg("-filter_complex").arg(&plan.filter_complex)
        .args(["-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest"])
        .arg(&temp_output).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| AppError::new("FFMPEG_NOT_FOUND", format!("Não foi possível iniciar FFmpeg: {error}")))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::new("RENDER_IO", "FFmpeg não abriu o canal de progresso"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| AppError::new("RENDER_IO", "FFmpeg não abriu o canal de erro"))?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes).await;
        bytes
    });
    let _ = window.emit("render-progress", 0.0f64);
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if state.render_cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = stderr_task.await;
            if let Some(path) = &subtitle_path { let _ = tokio::fs::remove_file(path).await; }
            let _ = tokio::fs::remove_file(&temp_output).await;
            state.render_cancel.store(false, Ordering::Relaxed);
            return Err(AppError::new("RENDER_CANCELLED", "Exportação cancelada"));
        }
        if let Some(value) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if let Ok(microseconds) = value.parse::<f64>() {
                let _ = window.emit("render-progress", (microseconds / 1_000_000.0 / duration_seconds).clamp(0.0, 0.99));
            }
        }
    }
    let status = child.wait().await?;
    let error_output = stderr_task.await.unwrap_or_default();
    if let Some(path) = &subtitle_path { let _ = tokio::fs::remove_file(path).await; }
    state.render_cancel.store(false, Ordering::Relaxed);
    if !status.success() {
        let _ = tokio::fs::remove_file(&temp_output).await;
        return Err(AppError::new("RENDER_FAILED", String::from_utf8_lossy(&error_output).trim().to_string()));
    }
    if output_path.exists() { tokio::fs::remove_file(&output_path).await?; }
    tokio::fs::rename(&temp_output, &output_path).await?;
    let _ = window.emit("render-progress", 1.0f64);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{EffectInstance, MediaAsset, TimelineClip, Transform};

    fn project_with_clip(path: &Path) -> EditorProject {
        let mut project = EditorProject::empty("Test");
        project.assets.push(MediaAsset { id: "asset".into(), name: "clip.mp4".into(), path: Some(path.to_string_lossy().into_owned()), object_url: None, duration_ticks: 2_400_000, width: Some(1920), height: Some(1080), fps: Some(30.0), codec: Some("h264".into()), has_audio: true, fingerprint: None, proxy_path: None, waveform: None, offline: false });
        project.active_sequence_mut().unwrap().tracks[0].clips.push(TimelineClip { id: "clip".into(), asset_id: "asset".into(), name: "clip.mp4".into(), start_tick: 240_000, source_in_tick: 240_000, duration_ticks: 480_000, speed: 2.0, volume: 0.5, transform: Transform::default(), effects: vec![], transition_in: None, transition_out: None });
        project
    }

    #[test]
    fn graph_uses_source_trim_speed_timeline_offset_and_audio_mix() {
        let media_file = tempfile::Builder::new().suffix(".mp4").tempfile().unwrap();
        let plan = build_render_plan(&project_with_clip(media_file.path()), None).unwrap();
        assert!(plan.filter_complex.contains("trim=start=1.000000:duration=4.000000"));
        assert!(plan.filter_complex.contains("setpts=PTS/2.000000+1.000000/TB"));
        assert!(plan.filter_complex.contains("atempo=2.000000"));
        assert!(plan.filter_complex.contains("amix=inputs=1"));
        assert!(plan.filter_complex.contains("overlay="));
    }

    #[test]
    fn subtitle_generation_uses_srt_timebase() {
        let media_file = tempfile::Builder::new().suffix(".mp4").tempfile().unwrap();
        let mut project = project_with_clip(media_file.path());
        project.active_sequence_mut().unwrap().captions.push(crate::domain::CaptionCue { id: "cue".into(), start_tick: 240_000, end_tick: 600_000, text: "Legenda".into() });
        let srt = subtitle_file(&project).unwrap();
        assert!(srt.contains("00:00:01,000 --> 00:00:02,500"));
    }

    #[tokio::test]
    async fn ffmpeg_accepts_the_generated_filter_graph() {
        if Command::new("ffmpeg").arg("-version").output().await.is_err() { return; }
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        let output = directory.path().join("output.mp4");
        let generated = Command::new("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "mpeg4", "-c:a", "aac"])
            .arg(&source).output().await.unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));

        let mut project = project_with_clip(&source);
        project.settings.width = 320;
        project.settings.height = 180;
        let clip = &mut project.active_sequence_mut().unwrap().tracks[0].clips[0];
        clip.start_tick = 0;
        clip.source_in_tick = 0;
        clip.duration_ticks = 240_000;
        clip.speed = 1.0;
        clip.effects.push(EffectInstance { id: "effect".into(), kind: "contrast".into(), enabled: true, value: 0.1 });
        let plan = build_render_plan(&project, None).unwrap();
        let mut render = Command::new("ffmpeg");
        render.args(["-hide_banner", "-v", "error", "-y"]);
        for input in &plan.inputs { render.arg("-i").arg(input); }
        let rendered = render.arg("-filter_complex").arg(&plan.filter_complex)
            .args(["-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
            .arg(&output).output().await.unwrap();
        assert!(rendered.status.success(), "{}\n{}", String::from_utf8_lossy(&rendered.stderr), plan.filter_complex);
        assert!(tokio::fs::metadata(output).await.unwrap().len() > 0);
    }
}
