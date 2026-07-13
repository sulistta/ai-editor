mod agent;
mod domain;
mod error;
mod media;
mod render;
mod runtime;
mod transcription;

use agent::{agent_plan, gemini_key_clear, gemini_key_set};
use domain::{
    project_apply, project_autosave, project_new, project_open, project_redo, project_save, project_snapshot,
    project_undo, AppState,
};
use media::{media_import, media_probe, media_proxy};
use render::{render_cancel, render_start};
use runtime::runtime_status;
use transcription::transcription_start;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            project_snapshot,
            project_new,
            project_apply,
            project_undo,
            project_redo,
            project_save,
            project_autosave,
            project_open,
            media_probe,
            media_import,
            media_proxy,
            transcription_start,
            gemini_key_set,
            gemini_key_clear,
            agent_plan,
            render_start,
            render_cancel,
            runtime_status,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Editor de Vídeo");
}
