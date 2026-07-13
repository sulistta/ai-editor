import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type {
  AgentStep,
  ChatMessage,
  EditCommand,
  EditorJob,
  EditorProject,
  MediaAsset,
  Selection,
  Transcript,
} from "../types";
import { activeSequence, applyTransaction, createEmptyProject, createId, makeClip, sequenceDuration } from "../lib/project";
import { errorMessage, isTauriRuntime, nativeApi } from "../lib/tauri";

interface EditorState {
  project: EditorProject;
  past: EditorProject[];
  future: EditorProject[];
  selection: Selection;
  playheadTick: number;
  isPlaying: boolean;
  zoom: number;
  leftTab: "media" | "effects" | "captions" | "transitions";
  rightTab: "inspector" | "chat";
  messages: ChatMessage[];
  agentSteps: AgentStep[];
  jobs: EditorJob[];
  error?: string;
  status: string;
}

type Action =
  | { type: "replaceProject"; project: EditorProject; remember?: boolean }
  | { type: "loadProject"; project: EditorProject }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "undoNative"; project: EditorProject }
  | { type: "redoNative"; project: EditorProject }
  | { type: "select"; selection: Selection }
  | { type: "playhead"; tick: number }
  | { type: "playing"; value: boolean }
  | { type: "zoom"; value: number }
  | { type: "leftTab"; value: EditorState["leftTab"] }
  | { type: "rightTab"; value: EditorState["rightTab"] }
  | { type: "message"; message: ChatMessage }
  | { type: "agentSteps"; steps: AgentStep[] }
  | { type: "job"; job: EditorJob }
  | { type: "error"; message?: string }
  | { type: "status"; value: string };

const initialState: EditorState = {
  project: createEmptyProject(),
  past: [],
  future: [],
  selection: { clipIds: [] },
  playheadTick: 0,
  isPlaying: false,
  zoom: 1,
  leftTab: "media",
  rightTab: "chat",
  messages: [],
  agentSteps: [],
  jobs: [],
  status: "Pronto",
};

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case "replaceProject":
      return {
        ...state,
        project: action.project,
        past: action.remember === false ? state.past : [...state.past.slice(-49), state.project],
        future: action.remember === false ? state.future : [],
      };
    case "loadProject":
      return { ...state, project: action.project, past: [], future: [], selection: { clipIds: [] }, playheadTick: 0, isPlaying: false };
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return { ...state, project: previous, past: state.past.slice(0, -1), future: [state.project, ...state.future] };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return { ...state, project: next, past: [...state.past, state.project], future: state.future.slice(1) };
    }
    case "undoNative":
      return { ...state, project: action.project, past: state.past.slice(0, -1), future: [state.project, ...state.future] };
    case "redoNative":
      return { ...state, project: action.project, past: [...state.past, state.project], future: state.future.slice(1) };
    case "select":
      return { ...state, selection: action.selection };
    case "playhead":
      return { ...state, playheadTick: Math.max(0, action.tick) };
    case "playing":
      return { ...state, isPlaying: action.value };
    case "zoom":
      return { ...state, zoom: Math.min(8, Math.max(0.25, action.value)) };
    case "leftTab":
      return { ...state, leftTab: action.value };
    case "rightTab":
      return { ...state, rightTab: action.value };
    case "message":
      return { ...state, messages: [...state.messages, action.message] };
    case "agentSteps":
      return { ...state, agentSteps: action.steps };
    case "job":
      return { ...state, jobs: [...state.jobs.filter((job) => job.id !== action.job.id), action.job] };
    case "error":
      return { ...state, error: action.message };
    case "status":
      return { ...state, status: action.value };
  }
}

interface EditorContextValue extends EditorState {
  commit: (label: string, commands: EditCommand[], source?: "manual" | "agent") => Promise<EditorProject>;
  importAsset: (asset: MediaAsset) => Promise<void>;
  insertAsset: (assetId: string) => Promise<void>;
  splitSelected: () => Promise<void>;
  deleteSelected: (ripple?: boolean) => Promise<void>;
  duplicateSelected: () => Promise<void>;
  updateSelectedClip: (patch: Record<string, unknown>) => Promise<void>;
  setTranscript: (transcript: Transcript) => Promise<void>;
  loadProject: (project: EditorProject) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  select: (selection: Selection) => void;
  setPlayhead: (tick: number) => void;
  setPlaying: (value: boolean) => void;
  setZoom: (value: number) => void;
  setLeftTab: (value: EditorState["leftTab"]) => void;
  setRightTab: (value: EditorState["rightTab"]) => void;
  addMessage: (role: ChatMessage["role"], text: string) => void;
  setAgentSteps: (steps: AgentStep[]) => void;
  setJob: (job: EditorJob) => void;
  setError: (message?: string) => void;
  setStatus: (value: string) => void;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const projectRef = useRef(state.project);
  const commitQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void nativeApi.snapshot().then((project) => {
      projectRef.current = project;
      dispatch({ type: "loadProject", project });
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || state.project.revision === 0) return;
    const timeout = window.setTimeout(() => {
      void nativeApi.autosave().catch((error) => dispatch({ type: "error", message: `Autosave: ${errorMessage(error)}` }));
    }, 1_200);
    return () => window.clearTimeout(timeout);
  }, [state.project.projectId, state.project.revision]);

  const commit = useCallback((label: string, commands: EditCommand[], source: "manual" | "agent" = "manual"): Promise<EditorProject> => {
    dispatch({ type: "status", value: label });
    const run = async () => {
      const current = projectRef.current;
      const transaction = { id: createId("transaction"), baseRevision: current.revision, source, label, commands } as const;
      if (!isTauriRuntime()) {
        const project = applyTransaction(current, transaction);
        projectRef.current = project;
        dispatch({ type: "replaceProject", project });
        return project;
      }
      try {
        const project = await nativeApi.apply(transaction);
        projectRef.current = project;
        dispatch({ type: "replaceProject", project });
        return project;
      } catch (error) {
        dispatch({ type: "error", message: errorMessage(error) });
        return projectRef.current;
      }
    };
    const pending = commitQueueRef.current.then(run, run);
    commitQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, []);

  const importAsset = useCallback(async (asset: MediaAsset) => {
    await commit(`Importar ${asset.name}`, [{ type: "addAsset", asset }]);
    dispatch({ type: "select", selection: { clipIds: [], assetId: asset.id } });
  }, [commit]);

  const insertAsset = useCallback(async (assetId: string) => {
    const asset = state.project.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const sequence = activeSequence(state.project);
    const mediaKind = asset.width && asset.height ? "video" : "audio";
    const track = sequence.tracks.find((item) => item.kind === mediaKind && !item.locked);
    if (!track) return;
    const clip = makeClip(asset, sequenceDuration(sequence));
    await commit(`Inserir ${asset.name}`, [{ type: "insertClip", trackId: track.id, clip }]);
    dispatch({ type: "select", selection: { clipIds: [clip.id], trackId: track.id, assetId } });
  }, [commit, state.project]);

  const splitSelected = useCallback(async () => {
    const clipId = state.selection.clipIds[0];
    const trackId = state.selection.trackId;
    if (!clipId || !trackId) return;
    await commit("Dividir clipe", [{ type: "splitClip", trackId, clipId, atTick: state.playheadTick, rightClipId: createId("clip") }]);
  }, [commit, state.playheadTick, state.selection]);

  const deleteSelected = useCallback(async (ripple = false) => {
    const trackId = state.selection.trackId;
    if (!trackId || state.selection.clipIds.length === 0) return;
    await commit(
      ripple ? "Excluir e fechar espaço" : "Excluir clipe",
      state.selection.clipIds.map((clipId) => ({ type: "deleteClip" as const, trackId, clipId, ripple })),
    );
    dispatch({ type: "select", selection: { clipIds: [] } });
  }, [commit, state.selection]);

  const duplicateSelected = useCallback(async () => {
    const trackId = state.selection.trackId;
    if (!trackId || state.selection.clipIds.length === 0) return;
    const track = activeSequence(state.project).tracks.find((item) => item.id === trackId);
    const selected = track?.clips.filter((clip) => state.selection.clipIds.includes(clip.id));
    if (!selected?.length) return;
    const from = Math.min(...selected.map((clip) => clip.startTick));
    const to = Math.max(...selected.map((clip) => clip.startTick + clip.durationTicks));
    const offset = Math.max(1, to - from);
    const duplicates = selected.map((clip) => ({ ...structuredClone(clip), id: createId("clip"), startTick: clip.startTick + offset }));
    await commit("Duplicar clipes", duplicates.map((clip) => ({ type: "insertClip" as const, trackId, clip })));
    dispatch({ type: "select", selection: { clipIds: duplicates.map((clip) => clip.id), trackId, assetId: duplicates[0]?.assetId } });
  }, [commit, state.project, state.selection]);

  const updateSelectedClip = useCallback(async (patch: Record<string, unknown>) => {
    const clipId = state.selection.clipIds[0];
    const trackId = state.selection.trackId;
    if (!clipId || !trackId) return;
    await commit("Ajustar clipe", [{ type: "updateClip", trackId, clipId, patch } as EditCommand]);
  }, [commit, state.selection]);

  const undo = useCallback(async () => {
    if (state.past.length === 0) return;
    await commitQueueRef.current;
    if (!isTauriRuntime()) {
      const previous = state.past.at(-1);
      if (previous) projectRef.current = previous;
      dispatch({ type: "undo" });
      return;
    }
    try {
      const project = await nativeApi.undo();
      projectRef.current = project;
      dispatch({ type: "undoNative", project });
    } catch (error) {
      dispatch({ type: "error", message: errorMessage(error) });
    }
  }, [state.past]);

  const redo = useCallback(async () => {
    if (state.future.length === 0) return;
    await commitQueueRef.current;
    if (!isTauriRuntime()) {
      const next = state.future[0];
      if (next) projectRef.current = next;
      dispatch({ type: "redo" });
      return;
    }
    try {
      const project = await nativeApi.redo();
      projectRef.current = project;
      dispatch({ type: "redoNative", project });
    } catch (error) {
      dispatch({ type: "error", message: errorMessage(error) });
    }
  }, [state.future]);

  const loadProject = useCallback((project: EditorProject) => {
    projectRef.current = project;
    dispatch({ type: "loadProject", project });
  }, []);

  const value = useMemo<EditorContextValue>(() => ({
    ...state,
    commit,
    importAsset,
    insertAsset,
    splitSelected,
    deleteSelected,
    duplicateSelected,
    updateSelectedClip,
    setTranscript: async (transcript) => { await commit("Salvar transcrição local", [{ type: "setTranscript", transcript }]); },
    loadProject,
    undo,
    redo,
    select: (selection) => dispatch({ type: "select", selection }),
    setPlayhead: (tick) => dispatch({ type: "playhead", tick }),
    setPlaying: (value) => dispatch({ type: "playing", value }),
    setZoom: (value) => dispatch({ type: "zoom", value }),
    setLeftTab: (value) => dispatch({ type: "leftTab", value }),
    setRightTab: (value) => dispatch({ type: "rightTab", value }),
    addMessage: (role, text) => dispatch({ type: "message", message: { id: createId("message"), role, text, createdAt: Date.now() } }),
    setAgentSteps: (steps) => dispatch({ type: "agentSteps", steps }),
    setJob: (job) => dispatch({ type: "job", job }),
    setError: (message) => dispatch({ type: "error", message }),
    setStatus: (value) => dispatch({ type: "status", value }),
  }), [commit, deleteSelected, duplicateSelected, importAsset, insertAsset, loadProject, redo, splitSelected, state, undo, updateSelectedClip]);

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

// O provider e o hook formam uma única fronteira de estado; mantê-los juntos evita
// expor o contexto mutável como parte da API pública.
// eslint-disable-next-line react-refresh/only-export-components
export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error("useEditor deve ser usado dentro de EditorProvider");
  return value;
}
