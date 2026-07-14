import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  EditTransaction,
  EditorProject,
  ChatMessage,
  GeminiPlan,
  MediaAsset,
  MediaProbe,
  RuntimeStatus,
  Selection,
  Transcript,
  TranscriptionRequest,
  WhisperModelStatus,
} from "../types";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "Ocorreu um erro inesperado";
}

export async function chooseMediaPaths(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Mídia", extensions: ["mp4", "mov", "mkv", "webm", "avi", "mp3", "wav", "flac", "m4a"] }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function chooseWhisperModelPath(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({ multiple: false, directory: false, filters: [{ name: "Modelo whisper.cpp", extensions: ["bin"] }] });
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

export async function chooseProjectPath(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return save({ defaultPath, filters: [{ name: "Projeto de edição", extensions: ["aivedit"] }] });
}

export async function chooseProjectOpenPath(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const selected = await open({ multiple: false, directory: false, filters: [{ name: "Projeto de edição", extensions: ["aivedit"] }] });
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

export async function chooseExportPath(defaultPath?: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  return save({ defaultPath, filters: [{ name: "Vídeo MP4", extensions: ["mp4"] }] });
}

export const nativeApi = {
  snapshot: () => invoke<EditorProject>("project_snapshot"),
  newProject: (name: string) => invoke<EditorProject>("project_new", { name }),
  apply: (transaction: EditTransaction) => invoke<EditorProject>("project_apply", { transaction }),
  undo: () => invoke<EditorProject>("project_undo"),
  redo: () => invoke<EditorProject>("project_redo"),
  save: (path: string) => invoke<void>("project_save", { path }),
  autosave: () => invoke<string>("project_autosave"),
  open: (path: string) => invoke<EditorProject>("project_open", { path }),
  probe: (path: string) => invoke<MediaProbe>("media_probe", { path }),
  import: (path: string, name: string) => invoke<MediaAsset>("media_import", { path, name }),
  importUrl: (url: string) => invoke<MediaAsset>("media_import_url", { url }),
  proxy: (path: string, fingerprint?: string) => invoke<string>("media_proxy", { path, fingerprint }),
  modelStatus: () => invoke<WhisperModelStatus[]>("model_status"),
  modelDownload: (modelId: string) => invoke<WhisperModelStatus>("model_download", { modelId }),
  modelCancelDownload: () => invoke<void>("model_cancel_download"),
  modelActivate: (modelId: string) => invoke<WhisperModelStatus>("model_activate", { modelId }),
  modelDelete: (modelId: string) => invoke<void>("model_delete", { modelId }),
  transcribe: (request: TranscriptionRequest) => invoke<Transcript>("transcription_start", { request }),
  planEdit: (prompt: string, project: EditorProject, history: ChatMessage[], selection: Selection) => invoke<GeminiPlan>("agent_plan", { prompt, project, history: history.map(({ role, text }) => ({ role, text })), selection }),
  setGeminiKey: (apiKey: string) => invoke<void>("gemini_key_set", { apiKey }),
  render: (outputPath: string) => invoke<void>("render_start", { outputPath }),
  cancelRender: () => invoke<void>("render_cancel"),
  runtimeStatus: (modelPath?: string) => invoke<RuntimeStatus>("runtime_status", { modelPath }),
};
