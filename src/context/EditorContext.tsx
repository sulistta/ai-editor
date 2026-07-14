import {
  createContext,
  useContext,
  useSyncExternalStore,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentStep,
  AnalysisProgressEvent,
  AssetAnalysis,
  ChatMessage,
  EditCommand,
  EditProposal,
  EditorJob,
  EditorProject,
  MediaAsset,
  Selection,
  Transcript,
} from "../types";
import { activeSequence, applyTransaction, createEmptyProject, createId, makeClip, sequenceDuration } from "../lib/project";
import { errorMessage, isTauriRuntime, nativeApi } from "../lib/tauri";

export interface EditorState {
  project: EditorProject;
  selection: Selection;
  playheadTick: number;
  isPlaying: boolean;
  zoom: number;
  leftTab: "media" | "analysis" | "effects" | "captions" | "transitions";
  rightTab: "inspector" | "chat";
  messages: ChatMessage[];
  agentSteps: AgentStep[];
  jobs: EditorJob[];
  analyses: Record<string, AssetAnalysis>;
  proposal?: EditProposal;
  showAnalysisOverlay: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error?: string;
  status: string;
}

export interface EditorActions {
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
  addMessage: (role: ChatMessage["role"], text: string, question?: ChatMessage["question"]) => void;
  setAgentSteps: (steps: AgentStep[]) => void;
  setJob: (job: EditorJob) => void;
  setAnalysis: (analysis: AssetAnalysis) => void;
  startAnalysis: (asset: MediaAsset, prompts?: string[], force?: boolean) => Promise<AssetAnalysis | undefined>;
  cancelAnalysis: (assetId: string) => Promise<void>;
  setProposal: (proposal?: EditProposal) => void;
  applyProposal: () => Promise<void>;
  rejectProposal: () => void;
  setShowAnalysisOverlay: (value: boolean) => void;
  setError: (message?: string) => void;
  setStatus: (value: string) => void;
}

const initialState = (): EditorState => ({
  project: createEmptyProject(),
  selection: { clipIds: [] },
  playheadTick: 0,
  isPlaying: false,
  zoom: 1,
  leftTab: "media",
  rightTab: "chat",
  messages: [],
  agentSteps: [],
  jobs: [],
  analyses: {},
  showAnalysisOverlay: true,
  canUndo: false,
  canRedo: false,
  status: "Pronto",
});

export class EditorStore {
  private state = initialState();
  private readonly listeners = new Set<() => void>();
  private readonly webPast: EditorProject[] = [];
  private readonly webFuture: EditorProject[] = [];
  private commitQueue: Promise<unknown> = Promise.resolve();
  private autosaveTimer?: number;
  private unlistenAnalysis?: UnlistenFn;
  private disposed = false;
  private lifecycleVersion = 0;

  readonly actions: EditorActions = {
    commit: (label, commands, source) => this.commit(label, commands, source),
    importAsset: (asset) => this.importAsset(asset),
    insertAsset: (assetId) => this.insertAsset(assetId),
    splitSelected: () => this.splitSelected(),
    deleteSelected: (ripple) => this.deleteSelected(ripple),
    duplicateSelected: () => this.duplicateSelected(),
    updateSelectedClip: (patch) => this.updateSelectedClip(patch),
    setTranscript: (transcript) => this.commit("Salvar transcrição local", [{ type: "setTranscript", transcript }]).then(() => undefined),
    loadProject: (project) => this.loadProject(project),
    undo: () => this.undo(),
    redo: () => this.redo(),
    select: (selection) => this.update({ selection }),
    setPlayhead: (tick) => this.update({ playheadTick: Math.max(0, tick) }),
    setPlaying: (isPlaying) => this.update({ isPlaying }),
    setZoom: (zoom) => this.update({ zoom: Math.min(8, Math.max(0.25, zoom)) }),
    setLeftTab: (leftTab) => this.update({ leftTab }),
    setRightTab: (rightTab) => this.update({ rightTab }),
    addMessage: (role, text, question) => this.update({ messages: [...this.state.messages, { id: createId("message"), role, text, question, createdAt: Date.now() }] }),
    setAgentSteps: (agentSteps) => this.update({ agentSteps }),
    setJob: (job) => this.setJob(job),
    setAnalysis: (analysis) => this.setAnalysis(analysis),
    startAnalysis: (asset, prompts, force) => this.startAnalysis(asset, prompts, force),
    cancelAnalysis: (assetId) => this.cancelAnalysis(assetId),
    setProposal: (proposal) => this.update({ proposal }),
    applyProposal: () => this.applyProposal(),
    rejectProposal: () => this.rejectProposal(),
    setShowAnalysisOverlay: (showAnalysisOverlay) => this.update({ showAnalysisOverlay }),
    setError: (error) => this.update({ error }),
    setStatus: (status) => this.update({ status }),
  };

  getSnapshot = (): EditorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async initialize(): Promise<void> {
    const lifecycleVersion = ++this.lifecycleVersion;
    this.disposed = false;
    if (!isTauriRuntime()) return;
    try {
      const unlistenAnalysis = await listen<AnalysisProgressEvent>("analysis-progress", ({ payload }) => {
        if (this.disposed || lifecycleVersion !== this.lifecycleVersion) return;
        this.setJob(payload.job);
        if (payload.analysis) this.setAnalysis(payload.analysis);
      });
      if (this.disposed || lifecycleVersion !== this.lifecycleVersion) {
        unlistenAnalysis();
        return;
      }
      this.unlistenAnalysis?.();
      this.unlistenAnalysis = unlistenAnalysis;
      const [project, history] = await Promise.all([nativeApi.snapshot(), nativeApi.historyStatus()]);
      if (this.disposed || lifecycleVersion !== this.lifecycleVersion) return;
      this.replaceLoadedProject(project);
      this.update(history);
      await this.hydrateAnalyses(project, lifecycleVersion);
    } catch (error) {
      if (!this.disposed && lifecycleVersion === this.lifecycleVersion) this.update({ error: errorMessage(error) });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleVersion += 1;
    this.unlistenAnalysis?.();
    this.unlistenAnalysis = undefined;
    if (this.autosaveTimer !== undefined) window.clearTimeout(this.autosaveTimer);
    for (const asset of this.state.project.assets) if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    this.listeners.clear();
  }

  private update(patch: Partial<EditorState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private replaceLoadedProject(project: EditorProject): void {
    this.webPast.length = 0;
    this.webFuture.length = 0;
    this.update({
      project,
      selection: { clipIds: [] },
      playheadTick: 0,
      isPlaying: false,
      proposal: undefined,
      canUndo: false,
      canRedo: false,
    });
  }

  private scheduleAutosave(project: EditorProject): void {
    if (!isTauriRuntime() || project.revision === 0) return;
    if (this.autosaveTimer !== undefined) window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      void nativeApi.autosave().catch((error) => this.update({ error: `Autosave: ${errorMessage(error)}` }));
    }, 1_200);
  }

  private async commit(label: string, commands: EditCommand[], source: "manual" | "agent" = "manual"): Promise<EditorProject> {
    if (commands.length === 0) return this.state.project;
    this.update({ status: label });
    const run = async () => {
      const current = this.state.project;
      const transaction = { id: createId("transaction"), baseRevision: current.revision, source, label, commands } as const;
      try {
        let project: EditorProject;
        if (isTauriRuntime()) {
          project = await nativeApi.apply(transaction);
        } else {
          this.webPast.push(current);
          if (this.webPast.length > 50) this.webPast.shift();
          this.webFuture.length = 0;
          project = applyTransaction(current, transaction);
        }
        this.update({ project, canUndo: true, canRedo: false });
        this.scheduleAutosave(project);
        return project;
      } catch (error) {
        const message = errorMessage(error);
        this.update({ error: message, status: `Falha: ${label}` });
        throw error;
      }
    };
    const pending = this.commitQueue.then(run, run);
    this.commitQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async importAsset(asset: MediaAsset): Promise<void> {
    await this.commit(`Importar ${asset.name}`, [{ type: "addAsset", asset }]);
    this.update({ selection: { clipIds: [], assetId: asset.id } });
    if (asset.path && asset.fingerprint && asset.width && asset.height) void this.startAnalysis(asset).catch(() => undefined);
  }

  private async insertAsset(assetId: string): Promise<void> {
    const asset = this.state.project.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const sequence = activeSequence(this.state.project);
    const mediaKind = asset.width && asset.height ? "video" : "audio";
    const track = sequence.tracks.find((item) => item.kind === mediaKind && !item.locked);
    if (!track) throw new Error(`Nenhuma faixa ${mediaKind} editável está disponível`);
    const clip = makeClip(asset, sequenceDuration(sequence));
    await this.commit(`Inserir ${asset.name}`, [{ type: "insertClip", trackId: track.id, clip }]);
    this.update({ selection: { clipIds: [clip.id], trackId: track.id, assetId } });
  }

  private selectedTarget(): { trackId: string; clipIds: string[] } | undefined {
    const { trackId, clipIds } = this.state.selection;
    return trackId && clipIds.length ? { trackId, clipIds } : undefined;
  }

  private async splitSelected(): Promise<void> {
    const target = this.selectedTarget();
    if (!target?.clipIds[0]) return;
    await this.commit("Dividir clipe", [{ type: "splitClip", trackId: target.trackId, clipId: target.clipIds[0], atTick: this.state.playheadTick, rightClipId: createId("clip") }]);
  }

  private async deleteSelected(ripple = false): Promise<void> {
    const target = this.selectedTarget();
    if (!target) return;
    await this.commit(
      ripple ? "Excluir e fechar espaço" : "Excluir clipe",
      target.clipIds.map((clipId) => ({ type: "deleteClip" as const, trackId: target.trackId, clipId, ripple })),
    );
    this.update({ selection: { clipIds: [] } });
  }

  private async duplicateSelected(): Promise<void> {
    const target = this.selectedTarget();
    if (!target) return;
    const track = activeSequence(this.state.project).tracks.find((item) => item.id === target.trackId);
    const selected = track?.clips.filter((clip) => target.clipIds.includes(clip.id));
    if (!selected?.length) return;
    const from = Math.min(...selected.map((clip) => clip.startTick));
    const to = Math.max(...selected.map((clip) => clip.startTick + clip.durationTicks));
    const offset = Math.max(1, to - from);
    const duplicates = selected.map((clip) => ({ ...structuredClone(clip), id: createId("clip"), startTick: clip.startTick + offset }));
    await this.commit("Duplicar clipes", duplicates.map((clip) => ({ type: "insertClip" as const, trackId: target.trackId, clip })));
    this.update({ selection: { clipIds: duplicates.map((clip) => clip.id), trackId: target.trackId, assetId: duplicates[0]?.assetId } });
  }

  private async updateSelectedClip(patch: Record<string, unknown>): Promise<void> {
    const target = this.selectedTarget();
    if (!target?.clipIds[0]) return;
    await this.commit("Ajustar clipe", [{ type: "updateClip", trackId: target.trackId, clipId: target.clipIds[0], patch } as EditCommand]);
  }

  private loadProject(project: EditorProject): void {
    this.replaceLoadedProject(project);
    void this.hydrateAnalyses(project);
  }

  private async undo(): Promise<void> {
    if (!this.state.canUndo) return;
    await this.commitQueue;
    try {
      let project: EditorProject | undefined;
      if (isTauriRuntime()) {
        project = await nativeApi.undo();
      } else {
        project = this.webPast.pop();
        if (project) this.webFuture.unshift(this.state.project);
      }
      if (!project) return;
      const history = isTauriRuntime() ? await nativeApi.historyStatus() : { canUndo: this.webPast.length > 0, canRedo: this.webFuture.length > 0 };
      this.update({ project, ...history, proposal: undefined });
    } catch (error) {
      this.update({ error: errorMessage(error) });
      throw error;
    }
  }

  private async redo(): Promise<void> {
    if (!this.state.canRedo) return;
    await this.commitQueue;
    try {
      let project: EditorProject | undefined;
      if (isTauriRuntime()) {
        project = await nativeApi.redo();
      } else {
        project = this.webFuture.shift();
        if (project) this.webPast.push(this.state.project);
      }
      if (!project) return;
      const history = isTauriRuntime() ? await nativeApi.historyStatus() : { canUndo: this.webPast.length > 0, canRedo: this.webFuture.length > 0 };
      this.update({ project, ...history, proposal: undefined });
    } catch (error) {
      this.update({ error: errorMessage(error) });
      throw error;
    }
  }

  private setJob(job: EditorJob): void {
    const jobs = [...this.state.jobs.filter((candidate) => candidate.id !== job.id), job].sort((left, right) => left.label.localeCompare(right.label));
    this.update({ jobs });
  }

  private setAnalysis(analysis: AssetAnalysis): void {
    this.update({ analyses: { ...this.state.analyses, [analysis.assetId]: analysis } });
  }

  private async hydrateAnalyses(project: EditorProject, lifecycleVersion = this.lifecycleVersion): Promise<void> {
    if (!isTauriRuntime()) return;
    const entries = await Promise.all(project.assets.filter((asset) => asset.fingerprint).map(async (asset) => {
      try {
        const analysis = await nativeApi.analysisGet(asset.id, asset.fingerprint!);
        return analysis ? [asset.id, analysis] as const : undefined;
      } catch {
        return undefined;
      }
    }));
    if (this.disposed || lifecycleVersion !== this.lifecycleVersion || this.state.project.projectId !== project.projectId) return;
    const analyses = { ...this.state.analyses };
    for (const entry of entries) if (entry) analyses[entry[0]] = entry[1];
    this.update({ analyses });
    for (const asset of project.assets) {
      if (!analyses[asset.id] && asset.path && asset.fingerprint && asset.width && asset.height) {
        void this.startAnalysis(asset).catch(() => undefined);
      }
    }
  }

  private async startAnalysis(asset: MediaAsset, prompts: string[] = [], force = false): Promise<AssetAnalysis | undefined> {
    if (!isTauriRuntime() || !asset.path || !asset.fingerprint || !asset.width || !asset.height) return;
    const jobId = `analysis-${asset.id}`;
    this.setJob({ id: jobId, kind: "analysis", label: `Análise local · ${asset.name}`, state: "queued", progress: 0, assetId: asset.id, stage: "scenes", cancellable: true });
    try {
      const analysis = await nativeApi.analysisStart({ assetId: asset.id, mediaPath: asset.path, fingerprint: asset.fingerprint, durationTicks: asset.durationTicks, prompts, force });
      this.setAnalysis(analysis);
      this.setJob({ id: jobId, kind: "analysis", label: `Análise local · ${asset.name}`, state: "completed", progress: 1, assetId: asset.id, stage: "ocr" });
      this.update({ status: `Análise local de ${asset.name} concluída` });
      return analysis;
    } catch (error) {
      const message = errorMessage(error);
      const cancelled = message.toLowerCase().includes("cancel");
      this.setJob({ id: jobId, kind: "analysis", label: `Análise local · ${asset.name}`, state: cancelled ? "cancelled" : "failed", progress: 0, detail: message, assetId: asset.id, stage: "scenes", retryable: !cancelled });
      if (!cancelled) this.update({ error: `Análise de “${asset.name}” falhou: ${message}` });
      throw error;
    }
  }

  private async cancelAnalysis(assetId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await nativeApi.analysisCancel(assetId);
    const current = this.state.jobs.find((job) => job.id === `analysis-${assetId}`);
    if (current) this.setJob({ ...current, state: "cancelled", detail: "Cancelamento solicitado" });
  }

  private async applyProposal(): Promise<void> {
    const proposal = this.state.proposal;
    if (!proposal) return;
    if (proposal.baseRevision !== this.state.project.revision) {
      const message = "A timeline mudou depois da proposta. Gere uma nova proposta antes de aplicar.";
      this.update({ error: message });
      throw new Error(message);
    }
    await this.commit(proposal.summary, proposal.operations, "agent");
    this.update({ proposal: undefined, agentSteps: [], status: "Proposta aplicada" });
    this.actions.addMessage("assistant", `Proposta aplicada: ${proposal.summary}`);
  }

  private rejectProposal(): void {
    const proposal = this.state.proposal;
    if (!proposal) return;
    this.update({ proposal: undefined, agentSteps: [], status: "Proposta descartada" });
    this.actions.addMessage("assistant", `Proposta descartada: ${proposal.summary}`);
  }
}

export const EditorStoreContext = createContext<EditorStore | null>(null);

function useStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store) throw new Error("EditorProvider ausente");
  return store;
}

export function useEditorSelector<T>(selector: (state: EditorState) => T): T {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()), () => selector(store.getSnapshot()));
}

export function useEditorActions(): EditorActions {
  return useStore().actions;
}
