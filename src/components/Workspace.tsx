import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditor } from "../context/EditorContext";
import { formatAgentQuestion, resolveRetryPrompt } from "../lib/agent";
import { scheduleAppSurfaceRefresh } from "../lib/compositor";
import { activeAudioPlaybackItems, activePlaybackItem, activeVideoPlaybackItem, mediaSecondsToTimelineTick, mediaVolume, needsCompatibilityProxy, playbackFailureMessage, playbackItems, playbackRecoveryAction, programPreviewTick, resolvePlaybackAsset, timelineTickToMediaSeconds, type PlaybackItem } from "../lib/playback";
import { activeSequence, captionsFromTranscript, createId, DEFAULT_CAPTION_STYLE, sequenceDuration } from "../lib/project";
import { chooseExportPath, chooseMediaPaths, chooseProjectOpenPath, chooseProjectPath, chooseWhisperModelPath, errorMessage, isTauriRuntime, nativeApi } from "../lib/tauri";
import { formatTimecode, secondsToTicks, ticksToSeconds } from "../lib/time";
import { autoTranscriptionDecision } from "../lib/transcription";
import type { CaptionCue, EffectInstance, MediaAsset, RuntimeStatus, TimelineClip, WhisperModelStatus } from "../types";
import { Icon, type IconName } from "./Icons";
import { Timeline } from "./Timeline";

const leftTabs: Array<{ id: "media" | "effects" | "captions" | "transitions"; label: string; icon: IconName }> = [
  { id: "media", label: "Media", icon: "media" },
  { id: "effects", label: "Effects", icon: "effects" },
  { id: "captions", label: "Captions", icon: "captions" },
  { id: "transitions", label: "Transitions", icon: "transitions" },
];

function selectedClipData(project: ReturnType<typeof useEditor>["project"], clipIds: string[]) {
  const sequence = activeSequence(project);
  for (const track of sequence.tracks) {
    const clip = track.clips.find((item) => clipIds.includes(item.id));
    if (clip) return { clip, track };
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 500 * 1024 * 1024 ? 0 : 1)} MiB`;
}

async function probeBrowserFile(file: File): Promise<MediaAsset> {
  const objectUrl = URL.createObjectURL(file);
  const media = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
  media.preload = "metadata";
  const metadata = await new Promise<{ duration: number; width?: number; height?: number }>((resolve) => {
    media.onloadedmetadata = () => resolve({ duration: Number.isFinite(media.duration) ? media.duration : 1, width: media instanceof HTMLVideoElement ? media.videoWidth : undefined, height: media instanceof HTMLVideoElement ? media.videoHeight : undefined });
    media.onerror = () => resolve({ duration: 1 });
    media.src = objectUrl;
  });
  return {
    id: createId("asset"),
    name: file.name,
    objectUrl,
    durationTicks: secondsToTicks(metadata.duration),
    width: metadata.width,
    height: metadata.height,
    codec: file.type || undefined,
    hasAudio: true,
    fingerprint: `${file.size}-${file.lastModified}`,
    offline: false,
  };
}

type AutomaticTranscriptionDecision = ReturnType<typeof autoTranscriptionDecision>;

function useAutomaticTranscription(editor: ReturnType<typeof useEditor>, modelPath: string) {
  const editorRef = useRef(editor);
  const modelPathRef = useRef(modelPath);
  const queuedAssetsRef = useRef(new Set<string>());
  const pendingAssetsRef = useRef(new Map<string, MediaAsset>());
  const taskQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    modelPathRef.current = modelPath;
  }, [modelPath]);

  const enqueue = useCallback((asset: MediaAsset, requestedModelPath: string) => {
    if (!asset.path || queuedAssetsRef.current.has(asset.id)) return;
    queuedAssetsRef.current.add(asset.id);
    pendingAssetsRef.current.delete(asset.id);
    const jobId = `transcription-${asset.id}`;
    const label = `Transcrição automática · ${asset.name}`;
    editorRef.current.setJob({ id: jobId, kind: "transcription", label, state: "queued", progress: 0, detail: "Aguardando execução" });

    const run = async () => {
      try {
        const current = editorRef.current;
        if (current.project.transcripts.some((transcript) => transcript.assetId === asset.id)) {
          current.setJob({ id: jobId, kind: "transcription", label, state: "completed", progress: 1 });
          return;
        }
        current.setJob({ id: jobId, kind: "transcription", label, state: "running", progress: 0 });
        current.setStatus(`Transcrevendo ${asset.name} automaticamente`);
        const transcript = await nativeApi.transcribe({ assetId: asset.id, mediaPath: asset.path!, modelPath: modelPathRef.current || requestedModelPath });
        if (!editorRef.current.project.assets.some((candidate) => candidate.id === asset.id)) {
          editorRef.current.setJob({ id: jobId, kind: "transcription", label, state: "cancelled", progress: 0, detail: "O projeto ativo mudou durante a transcrição" });
          return;
        }
        await editorRef.current.setTranscript(transcript);
        editorRef.current.setJob({ id: jobId, kind: "transcription", label, state: "completed", progress: 1 });
        editorRef.current.setStatus(`Transcrição automática de ${asset.name} concluída`);
      } catch (error) {
        const detail = errorMessage(error);
        pendingAssetsRef.current.set(asset.id, asset);
        editorRef.current.setJob({ id: jobId, kind: "transcription", label, state: "failed", progress: 0, detail });
        editorRef.current.setError(`Transcrição automática de “${asset.name}” falhou: ${detail}`);
      } finally {
        queuedAssetsRef.current.delete(asset.id);
      }
    };

    taskQueueRef.current = taskQueueRef.current.then(run, run);
  }, []);

  const resumePending = useCallback((nextModelPath: string) => {
    if (!nextModelPath) return;
    modelPathRef.current = nextModelPath;
    for (const asset of pendingAssetsRef.current.values()) {
      if (editorRef.current.project.assets.some((candidate) => candidate.id === asset.id)) enqueue(asset, nextModelPath);
      else pendingAssetsRef.current.delete(asset.id);
    }
  }, [enqueue]);

  useEffect(() => {
    resumePending(modelPath);
  }, [modelPath, resumePending]);

  const schedule = useCallback((asset: MediaAsset): AutomaticTranscriptionDecision => {
    const current = editorRef.current;
    const decision = autoTranscriptionDecision(asset, {
      desktop: isTauriRuntime(),
      hasModel: Boolean(modelPathRef.current),
      hasTranscript: current.project.transcripts.some((transcript) => transcript.assetId === asset.id),
    });
    if (decision === "ready") enqueue(asset, modelPathRef.current);
    if (decision === "waiting-model") {
      pendingAssetsRef.current.set(asset.id, asset);
      current.setJob({
        id: `transcription-${asset.id}`,
        kind: "transcription",
        label: `Transcrição automática · ${asset.name}`,
        state: "queued",
        progress: 0,
        detail: "Aguardando modelo Whisper ativo",
      });
      current.setStatus(`${asset.name} importado; transcrição aguardando um modelo Whisper`);
    }
    return decision;
  }, [enqueue]);

  return { schedule, resumePending };
}

function TopBar() {
  const editor = useEditor();
  const [rendering, setRendering] = useState(false);
  const renderCancelled = useRef(false);

  const openProject = async () => {
    const path = await chooseProjectOpenPath();
    if (!path) return;
    try {
      const project = await nativeApi.open(path);
      editor.loadProject(project);
      editor.setStatus("Projeto aberto");
    } catch (error) {
      editor.setError(errorMessage(error));
    }
  };

  const saveProject = async () => {
    const path = await chooseProjectPath(`${editor.project.name}.aivedit`);
    if (!path) {
      editor.setStatus(isTauriRuntime() ? "Salvamento cancelado" : "Salvar está disponível no aplicativo desktop");
      return;
    }
    await nativeApi.save(path);
    editor.setStatus("Projeto salvo");
  };

  const exportVideo = async () => {
    if (rendering) {
      renderCancelled.current = true;
      await nativeApi.cancelRender();
      return;
    }
    const path = await chooseExportPath(`${editor.project.name}.mp4`);
    if (!path) {
      editor.setStatus(isTauriRuntime() ? "Exportação cancelada" : "Exportar está disponível no aplicativo desktop");
      return;
    }
    const jobId = createId("render");
    setRendering(true);
    renderCancelled.current = false;
    editor.setJob({ id: jobId, kind: "render", label: "Exportação H.264", state: "running", progress: 0 });
    let unlisten: UnlistenFn | undefined;
    try {
      unlisten = await listen<number>("render-progress", (event) => editor.setJob({ id: jobId, kind: "render", label: "Exportação H.264", state: "running", progress: event.payload }));
      await nativeApi.render(path);
      editor.setJob({ id: jobId, kind: "render", label: "Exportação H.264", state: "completed", progress: 1 });
      editor.setStatus("Exportação concluída");
    } catch (error) {
      const cancelled = renderCancelled.current || errorMessage(error).toLowerCase().includes("cancel");
      editor.setJob({ id: jobId, kind: "render", label: "Exportação H.264", state: cancelled ? "cancelled" : "failed", progress: 0, detail: errorMessage(error) });
      if (!cancelled) editor.setError(errorMessage(error));
      else editor.setStatus("Exportação cancelada");
    } finally {
      unlisten?.();
      setRendering(false);
    }
  };

  return (
    <header className="topbar">
      <div className="product-mark"><span className="mark-block" /> Editor de Vídeo</div>
      <div className="project-title"><span>{editor.project.name}</span><span className="unsaved-dot" title="Revisão atual" /></div>
      <div className="topbar-actions">
        <button className="icon-button" onClick={() => void editor.undo()} disabled={editor.past.length === 0} title="Desfazer" aria-label="Desfazer"><Icon name="undo" /></button>
        <button className="icon-button" onClick={() => void editor.redo()} disabled={editor.future.length === 0} title="Refazer" aria-label="Refazer"><Icon name="redo" /></button>
        <span className="topbar-divider" />
        <button className="text-button" onClick={() => void openProject()}><Icon name="open" /> Abrir</button>
        <button className="text-button" onClick={() => void saveProject()}><Icon name="save" /> Salvar</button>
        <button className={rendering ? "stop-button export-stop" : "primary-button"} onClick={() => void exportVideo()}><Icon name={rendering ? "stop" : "export"} /> {rendering ? "Cancelar" : "Exportar"}</button>
      </div>
    </header>
  );
}

function MediaPanel({
  modelPath,
  onModelPathChange,
  scheduleAutomaticTranscription,
}: {
  modelPath: string;
  onModelPathChange: (path: string) => void;
  scheduleAutomaticTranscription: (asset: MediaAsset) => AutomaticTranscriptionDecision;
}) {
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [showUrlImport, setShowUrlImport] = useState(false);
  const [downloadingUrl, setDownloadingUrl] = useState(false);
  const [showModels, setShowModels] = useState(() => editor.jobs.some((job) => job.kind === "transcription" && job.state === "queued" && job.detail?.includes("modelo Whisper")));
  const [models, setModels] = useState<WhisperModelStatus[]>([]);
  const [modelBusy, setModelBusy] = useState<string>();
  const modelManagerRef = useRef<HTMLElement>(null);
  const setEditorErrorRef = useRef(editor.setError);
  const filtered = editor.project.assets.filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    setEditorErrorRef.current = editor.setError;
  }, [editor.setError]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    const load = async () => {
      try {
        const next = await nativeApi.modelStatus();
        if (disposed) return;
        setModels(next);
        const active = next.find((item) => item.active);
        if (active) {
          onModelPathChange(active.path);
        } else if (!next.some((item) => item.downloaded)) {
          setShowModels(true);
        }
      } catch (error) {
        if (!disposed) setEditorErrorRef.current(errorMessage(error));
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [onModelPathChange]);

  useEffect(() => {
    if (!showModels || !modelManagerRef.current) return;
    modelManagerRef.current.scrollIntoView({ block: "end" });
  }, [models.length, showModels]);

  const scheduleImportedAsset = (asset: MediaAsset) => {
    if (scheduleAutomaticTranscription(asset) === "waiting-model") setShowModels(true);
  };

  const importFiles = async () => {
    if (!isTauriRuntime()) {
      inputRef.current?.click();
      return;
    }
    const paths = await chooseMediaPaths();
    for (const path of paths) {
      try {
        const name = path.split(/[\\/]/).at(-1) ?? "Mídia";
        const asset = await nativeApi.import(path, name);
        await editor.importAsset(asset);
        scheduleImportedAsset(asset);
        if (needsCompatibilityProxy(asset)) void createProxy(asset);
      } catch (error) {
        editor.setError(errorMessage(error));
      }
    }
  };

  const onBrowserFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const asset = await probeBrowserFile(file);
      await editor.importAsset(asset);
      scheduleImportedAsset(asset);
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const importYoutube = async () => {
    const value = url.trim();
    if (!value || downloadingUrl) return;
    if (!isTauriRuntime()) {
      editor.setError("A importação do YouTube requer o aplicativo desktop.");
      return;
    }
    const jobId = createId("download");
    setDownloadingUrl(true);
    editor.setJob({ id: jobId, kind: "download", label: "Baixando vídeo do YouTube", state: "running", progress: 0.1 });
    editor.setStatus("Baixando vídeo do YouTube");
    try {
      const asset = await nativeApi.importUrl(value);
      await editor.importAsset(asset);
      scheduleImportedAsset(asset);
      if (needsCompatibilityProxy(asset)) void createProxy(asset);
      editor.setJob({ id: jobId, kind: "download", label: `YouTube · ${asset.name}`, state: "completed", progress: 1 });
      editor.setStatus("Vídeo do YouTube importado");
      setUrl("");
      setShowUrlImport(false);
    } catch (error) {
      const detail = errorMessage(error);
      editor.setJob({ id: jobId, kind: "download", label: "Importação do YouTube", state: "failed", progress: 0, detail });
      editor.setError(detail);
    } finally {
      setDownloadingUrl(false);
    }
  };

  const relink = async (asset: MediaAsset) => {
    const [path] = await chooseMediaPaths();
    if (!path) return;
    try {
      const replacement = await nativeApi.import(path, path.split(/[\\/]/).at(-1) ?? asset.name);
      const relinkedAsset = { ...replacement, id: asset.id };
      await editor.commit("Relink de mídia", [{ type: "updateAsset", asset: relinkedAsset }]);
      scheduleImportedAsset(relinkedAsset);
      editor.setStatus("Mídia relinkada");
    } catch (error) {
      editor.setError(errorMessage(error));
    }
  };

  const createProxy = async (asset: MediaAsset) => {
    if (!asset.path || !isTauriRuntime()) return;
    const jobId = `proxy-${asset.id}`;
    editor.setJob({ id: jobId, kind: "proxy", label: `Proxy ${asset.name}`, state: "running", progress: 0 });
    try {
      const proxyPath = await nativeApi.proxy(asset.path, asset.fingerprint);
      await editor.commit("Associar proxy", [{ type: "updateAsset", asset: { ...asset, proxyPath } }]);
      editor.setJob({ id: jobId, kind: "proxy", label: `Proxy ${asset.name}`, state: "completed", progress: 1 });
      editor.setStatus("Proxy 720p concluído");
    } catch (error) {
      editor.setJob({ id: jobId, kind: "proxy", label: `Proxy ${asset.name}`, state: "failed", progress: 0, detail: errorMessage(error) });
      editor.setError(errorMessage(error));
    }
  };

  const chooseModel = async () => {
    const path = await chooseWhisperModelPath();
    if (!path) return;
    onModelPathChange(path);
    editor.setStatus("Modelo whisper.cpp configurado");
  };

  const refreshModels = async () => {
    const next = await nativeApi.modelStatus();
    setModels(next);
    const active = next.find((item) => item.active);
    if (active) {
      onModelPathChange(active.path);
    } else if (!modelPath) {
      localStorage.removeItem("whisperModelPath");
    }
  };

  const downloadModel = async (model: WhisperModelStatus) => {
    if (modelBusy) return;
    const jobId = `model-${model.info.id}`;
    setModelBusy(model.info.id);
    editor.setJob({ id: jobId, kind: "model", label: `Baixando ${model.info.label}`, state: "running", progress: 0 });
    editor.setStatus(`Baixando modelo ${model.info.label}`);
    try {
      const active = await nativeApi.modelDownload(model.info.id);
      onModelPathChange(active.path);
      await refreshModels();
      editor.setJob({ id: jobId, kind: "model", label: `Modelo ${model.info.label}`, state: "completed", progress: 1 });
      editor.setStatus(`Modelo ${model.info.label} ativo`);
    } catch (error) {
      editor.setJob({ id: jobId, kind: "model", label: `Modelo ${model.info.label}`, state: "failed", progress: 0, detail: errorMessage(error) });
      editor.setError(errorMessage(error));
    } finally {
      setModelBusy(undefined);
    }
  };

  const cancelModelDownload = async () => {
    if (!modelBusy) return;
    await nativeApi.modelCancelDownload();
    editor.setStatus("Download do modelo cancelado");
  };

  const activateModel = async (model: WhisperModelStatus) => {
    try {
      const active = await nativeApi.modelActivate(model.info.id);
      onModelPathChange(active.path);
      await refreshModels();
      editor.setStatus(`Modelo ${model.info.label} ativo`);
    } catch (error) {
      editor.setError(errorMessage(error));
    }
  };

  const deleteModel = async (model: WhisperModelStatus) => {
    try {
      await nativeApi.modelDelete(model.info.id);
      await refreshModels();
      editor.setStatus(`Modelo ${model.info.label} removido`);
    } catch (error) {
      editor.setError(errorMessage(error));
    }
  };

  return (
    <div className="panel-content media-panel">
      <div className="panel-action-row">
        <button className="primary-button compact" onClick={() => void importFiles()}><Icon name="plus" /> Arquivo</button>
        <button className={`text-button compact ${showUrlImport ? "active" : ""}`} onClick={() => setShowUrlImport((value) => !value)}><Icon name="open" /> YouTube</button>
        <input ref={inputRef} className="sr-only" type="file" accept="video/*,audio/*" multiple onChange={(event) => void onBrowserFiles(event.target.files)} />
      </div>
      {showUrlImport && <form className="url-import" onSubmit={(event) => { event.preventDefault(); void importYoutube(); }}>
        <label htmlFor="youtube-url">URL do YouTube</label>
        <div><input id="youtube-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://youtube.com/watch?v=…" autoFocus /><button className="primary-button compact" disabled={!url.trim() || downloadingUrl}>{downloadingUrl ? "Baixando" : "Importar"}</button></div>
        <small>Use apenas vídeos que você tem permissão para baixar.</small>
      </form>}
      <label className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar mídia" /></label>
      <div className="asset-list" role="list">
        {filtered.length === 0 ? (
          <div className="empty-panel"><Icon name="media" /><strong>Nenhuma mídia</strong><span>Importe arquivos para montar a sequência.</span></div>
        ) : filtered.map((asset) => {
          const transcript = editor.project.transcripts.find((item) => item.assetId === asset.id);
          const transcriptionJob = editor.jobs.find((job) => job.id === `transcription-${asset.id}`);
          const transcriptionStatus = transcript
            ? "Transcrição disponível"
            : transcriptionJob?.state === "running"
              ? "Transcrevendo automaticamente"
              : transcriptionJob?.state === "queued"
                ? transcriptionJob.detail ?? "Transcrição na fila"
                : transcriptionJob?.state === "failed"
                  ? `Falha na transcrição: ${transcriptionJob.detail ?? "erro desconhecido"}`
                  : !asset.hasAudio
                    ? "Mídia sem faixa de áudio"
                    : !isTauriRuntime()
                      ? "Transcrição local indisponível no preview web"
                      : "Sem transcrição automática registrada";
          const selected = editor.selection.assetId === asset.id;
          return (
            <article
              key={asset.id}
              className={`asset-row ${selected ? "selected" : ""} ${asset.offline ? "offline" : ""}`}
              onClick={() => editor.select({ clipIds: [], assetId: asset.id })}
              onDoubleClick={() => void editor.insertAsset(asset.id)}
              draggable={!asset.offline}
              onDragStart={(event) => { event.dataTransfer.setData("application/x-ai-editor-asset", asset.id); event.dataTransfer.effectAllowed = "copy"; }}
              role="listitem"
            >
              <div className="asset-thumb"><Icon name={asset.codec?.startsWith("audio") ? "audio" : "video"} /></div>
              <div className="asset-meta"><strong>{asset.name}</strong><span>{asset.offline ? "OFFLINE · clique para relink" : `${formatTimecode(asset.durationTicks)} · ${asset.width && asset.height ? `${asset.width}×${asset.height}` : "Áudio"}`}</span></div>
              <div className="asset-actions"><button className={`asset-status ${asset.proxyPath ? "ready" : ""}`} disabled={asset.offline || !asset.width} onClick={(event) => { event.stopPropagation(); void createProxy(asset); }} title={asset.proxyPath ? "Proxy disponível" : "Gerar proxy 720p"} aria-label={`Gerar proxy de ${asset.name}`}><Icon name="settings" /></button>{asset.offline ? <button className="asset-status" onClick={(event) => { event.stopPropagation(); void relink(asset); }} title="Relink de mídia" aria-label={`Relink ${asset.name}`}><Icon name="open" /></button> : <span className={`asset-status transcription-indicator ${transcript ? "ready" : transcriptionJob?.state ?? "idle"}`} title={transcriptionStatus} role="status" aria-label={transcriptionStatus}><Icon name="transcript" /></span>}</div>
            </article>
          );
        })}
      </div>
      {filtered.length > 0 && <p className="panel-hint">Clique duas vezes para inserir na timeline.</p>}
      {showModels && <section ref={modelManagerRef} className="model-manager" aria-label="Modelos locais">
        <header><span><Icon name="settings" /><span><strong>Modelos locais</strong><small>{modelPath ? modelPath.split(/[\\/]/).at(-1) : "Nenhum modelo ativo"}</small></span></span><button className="text-button compact" onClick={() => void chooseModel()} disabled={!isTauriRuntime()}>Arquivo .bin</button></header>
        {!isTauriRuntime() ? <p className="model-empty">Disponível no aplicativo desktop.</p> : models.length === 0 ? <p className="model-empty">Carregando modelos…</p> : <div className="model-list">{models.map((model) => {
          const downloading = modelBusy === model.info.id;
          return <article className={`model-option ${model.active ? "active" : ""}`} key={model.info.id}>
            <div className="model-copy"><div><strong>{model.info.label}</strong>{model.info.recommended && <span className="model-badge">Recomendado</span>}{model.active && <span className="model-badge active">Ativo</span>}</div><small>{model.info.detail} · {formatBytes(model.info.sizeBytes)}</small></div>
            <div className="model-actions">{downloading ? <><span className="model-progress">Baixando…</span><button className="text-button compact" onClick={() => void cancelModelDownload()}>Cancelar</button></> : model.active ? <span className="model-ready">Pronto</span> : model.downloaded && model.verified ? <><button className="text-button compact" onClick={() => void activateModel(model)}>Ativar</button><button className="icon-button compact" onClick={() => void deleteModel(model)} aria-label={`Excluir modelo ${model.info.label}`} title={`Excluir modelo ${model.info.label}`}><Icon name="trash" /></button></> : <button className="primary-button compact" onClick={() => void downloadModel(model)}>Baixar</button>}</div>
          </article>;
        })}</div>}
      </section>}
      <div className="local-model"><span><Icon name="settings" /><span><strong>whisper.cpp local</strong><small>{modelPath ? modelPath.split(/[\\/]/).at(-1) : "Nenhum modelo ativo"}</small></span></span><div className="local-model-actions"><button className={`text-button compact ${showModels ? "active" : ""}`} onClick={() => setShowModels((value) => !value)} disabled={!isTauriRuntime()}>Modelos</button><button className="text-button compact" onClick={() => void chooseModel()} disabled={!isTauriRuntime()}>Arquivo</button></div></div>
    </div>
  );
}

const effectDefinitions: Array<{ kind: EffectInstance["kind"]; label: string; detail: string; initial: number }> = [
  { kind: "exposure", label: "Exposure", detail: "Luminância primária", initial: 0 },
  { kind: "contrast", label: "Contrast", detail: "Separação tonal", initial: 0 },
  { kind: "saturation", label: "Saturation", detail: "Intensidade de cor", initial: 0 },
  { kind: "temperature", label: "Temperature", detail: "Balanço quente/frio", initial: 0 },
  { kind: "chromaKey", label: "Chroma key", detail: "Recorte de fundo", initial: 0.2 },
  { kind: "blur", label: "Blur", detail: "Desfoque gaussiano", initial: 0 },
];

function EffectsPanel() {
  const editor = useEditor();
  const selected = selectedClipData(editor.project, editor.selection.clipIds);
  const addEffect = async (definition: (typeof effectDefinitions)[number]) => {
    if (!selected) return;
    const effects = [...selected.clip.effects, { id: createId("effect"), kind: definition.kind, enabled: true, value: definition.initial }];
    await editor.updateSelectedClip({ effects });
  };
  return (
    <div className="panel-content tool-list">
      {!selected && <p className="callout">Selecione um clipe para aplicar efeitos.</p>}
      {effectDefinitions.map((effect) => (
        <button key={effect.kind} className="tool-row" disabled={!selected} onClick={() => void addEffect(effect)}>
          <Icon name="effects" /><span><strong>{effect.label}</strong><small>{effect.detail}</small></span><Icon name="plus" />
        </button>
      ))}
    </div>
  );
}

function CaptionsPanel() {
  const editor = useEditor();
  const sequence = activeSequence(editor.project);
  const style = sequence.captionStyle ?? DEFAULT_CAPTION_STYLE;
  const selectedAssetId = editor.selection.assetId;
  const transcript = editor.project.transcripts.find((item) => item.assetId === selectedAssetId) ?? editor.project.transcripts[0];
  const createCaptions = async () => {
    if (!transcript) return;
    const captions: CaptionCue[] = captionsFromTranscript(editor.project, transcript);
    await editor.commit("Criar legendas do transcript", [{ type: "setCaptions", sequenceId: sequence.id, captions }]);
  };
  const addCaption = async () => {
    const cue: CaptionCue = { id: createId("caption"), startTick: editor.playheadTick, endTick: editor.playheadTick + secondsToTicks(3), text: "Nova legenda" };
    await editor.commit("Adicionar legenda", [{ type: "setCaptions", sequenceId: sequence.id, captions: [...sequence.captions, cue].sort((a, b) => a.startTick - b.startTick) }]);
  };
  const updateCaption = async (cue: CaptionCue, text: string) => {
    await editor.commit("Editar legenda", [{ type: "setCaptions", sequenceId: sequence.id, captions: sequence.captions.map((item) => item.id === cue.id ? { ...item, text } : item) }]);
  };
  const removeCaption = async (cueId: string) => {
    await editor.commit("Excluir legenda", [{ type: "setCaptions", sequenceId: sequence.id, captions: sequence.captions.filter((item) => item.id !== cueId) }]);
  };
  const updateStyle = async (patch: Partial<typeof style>) => {
    await editor.commit("Estilizar legendas", [{ type: "setCaptionStyle", sequenceId: sequence.id, style: { ...style, ...patch } }]);
  };
  return (
    <div className="panel-content captions-panel">
      <div className="panel-action-row"><button className="primary-button compact" disabled={!transcript} onClick={() => void createCaptions()}><Icon name="captions" /> Do transcript</button><button className="text-button" onClick={() => void addCaption()}><Icon name="plus" /> Manual</button></div>
      <div className="caption-style-editor">
        <label>Fonte<select value={style.fontFamily} onChange={(event) => void updateStyle({ fontFamily: event.target.value as typeof style.fontFamily })}><option value="modern">Moderna</option><option value="mono">Mono</option><option value="serif">Serif</option></select></label>
        <label>Tamanho<input type="number" min="12" max="160" value={style.fontSize} onChange={(event) => void updateStyle({ fontSize: Math.max(12, Math.min(160, Number(event.target.value))) })} /></label>
        <label>Texto<input type="color" value={style.textColor} onChange={(event) => void updateStyle({ textColor: event.target.value.toUpperCase() })} /></label>
        <label>Posição<select value={style.position} onChange={(event) => void updateStyle({ position: event.target.value as typeof style.position })}><option value="bottom">Inferior</option><option value="center">Centro</option><option value="top">Superior</option></select></label>
        <label className="caption-toggle"><input type="checkbox" checked={style.background} onChange={(event) => void updateStyle({ background: event.target.checked })} /> Fundo</label>
        <label className="caption-toggle"><input type="checkbox" checked={style.uppercase} onChange={(event) => void updateStyle({ uppercase: event.target.checked })} /> Maiúsculas</label>
      </div>
      {sequence.captions.length > 0 && <div className="caption-cue-list"><header>Legendas da sequência <span>{sequence.captions.length}</span></header>{sequence.captions.map((cue) => <article key={cue.id} onClick={() => editor.setPlayhead(cue.startTick)}><time>{formatTimecode(cue.startTick).slice(3, -3)}</time><input defaultValue={cue.text} key={`${cue.id}-${cue.text}`} onClick={(event) => event.stopPropagation()} onBlur={(event) => { if (event.target.value !== cue.text) void updateCaption(cue, event.target.value); }} aria-label={`Texto em ${formatTimecode(cue.startTick)}`} /><button className="icon-button" onClick={(event) => { event.stopPropagation(); void removeCaption(cue.id); }} aria-label="Excluir legenda"><Icon name="trash" /></button></article>)}</div>}
      {!transcript ? <div className="empty-panel"><Icon name="transcript" /><strong>Sem transcrição</strong><span>Transcreva um arquivo na aba Media.</span></div> : (
        <div className="transcript-list"><header>Transcript fonte</header>
          {transcript.segments.map((segment) => <button key={segment.id} onClick={() => editor.setPlayhead(segment.startTick)}><time>{formatTimecode(segment.startTick).slice(3, -3)}</time><span>{segment.text}</span></button>)}
        </div>
      )}
    </div>
  );
}

const transitionDefinitions = [
  { kind: "crossDissolve", label: "Cross dissolve" },
  { kind: "dipToBlack", label: "Dip to black" },
  { kind: "slide", label: "Slide" },
  { kind: "audioCrossfade", label: "Audio crossfade" },
] as const;

function TransitionsPanel() {
  const editor = useEditor();
  const selected = selectedClipData(editor.project, editor.selection.clipIds);
  const apply = async (kind: (typeof transitionDefinitions)[number]["kind"], edge: "transitionIn" | "transitionOut") => {
    if (!selected) return;
    await editor.updateSelectedClip({ [edge]: { kind, durationTicks: secondsToTicks(0.5) } });
  };
  return (
    <div className="panel-content tool-list">
      {!selected && <p className="callout">Selecione um clipe para definir a transição.</p>}
      {transitionDefinitions.map((transition) => (
        <article className="transition-row" key={transition.kind}>
          <Icon name="transitions" />
          <span><strong>{transition.label}</strong><small>500 ms · ajuste no Inspector</small></span>
          <div><button disabled={!selected} onClick={() => void apply(transition.kind, "transitionIn")}>IN</button><button disabled={!selected} onClick={() => void apply(transition.kind, "transitionOut")}>OUT</button></div>
        </article>
      ))}
    </div>
  );
}

function LeftPanel({
  modelPath,
  onModelPathChange,
  scheduleAutomaticTranscription,
}: {
  modelPath: string;
  onModelPathChange: (path: string) => void;
  scheduleAutomaticTranscription: (asset: MediaAsset) => AutomaticTranscriptionDecision;
}) {
  const editor = useEditor();
  return (
    <aside className="left-panel" aria-label="Biblioteca e ferramentas">
      <nav className="panel-tabs" aria-label="Ferramentas">
        {leftTabs.map((tab) => <button key={tab.id} className={editor.leftTab === tab.id ? "active" : ""} onClick={() => editor.setLeftTab(tab.id)} title={tab.label}><Icon name={tab.icon} /><span>{tab.label}</span></button>)}
      </nav>
      <div className="panel-heading"><h2>{leftTabs.find((tab) => tab.id === editor.leftTab)?.label}</h2><button className="icon-button" aria-label="Opções do painel"><Icon name="settings" /></button></div>
      {editor.leftTab === "media" && <MediaPanel modelPath={modelPath} onModelPathChange={onModelPathChange} scheduleAutomaticTranscription={scheduleAutomaticTranscription} />}
      {editor.leftTab === "effects" && <EffectsPanel />}
      {editor.leftTab === "captions" && <CaptionsPanel />}
      {editor.leftTab === "transitions" && <TransitionsPanel />}
    </aside>
  );
}

function clipCssFilter(clip: TimelineClip): string | undefined {
  const enabled = clip.effects.filter((effect) => effect.enabled);
  if (!enabled.length) return undefined;
  const filters: string[] = [];
  for (const effect of enabled) {
    if (effect.kind === "exposure") filters.push(`brightness(${Math.max(0, 1 + effect.value)})`);
    if (effect.kind === "contrast") filters.push(`contrast(${Math.max(0, 1 + effect.value)})`);
    if (effect.kind === "saturation") filters.push(`saturate(${Math.max(0, 1 + effect.value)})`);
    if (effect.kind === "temperature") filters.push(`sepia(${Math.max(0, effect.value) * 0.45})`);
    if (effect.kind === "blur") filters.push(`blur(${Math.abs(effect.value) * 10}px)`);
  }
  return filters.join(" ") || undefined;
}

function configureMediaElement(media: HTMLMediaElement, item: PlaybackItem, timelineTick: number) {
  const seconds = timelineTickToMediaSeconds(item.clip, timelineTick);
  const audio = mediaVolume(item.clip, item.track);
  media.playbackRate = item.clip.speed;
  media.muted = audio.muted;
  media.volume = audio.volume;
  if (Number.isFinite(media.duration) && Math.abs(media.currentTime - seconds) > 0.08) {
    media.currentTime = Math.min(media.duration, Math.max(0, seconds));
  }
}

function resolveMediaSource(asset: MediaAsset | undefined, localPath: string | undefined, blocked = false) {
  if (asset?.objectUrl) return { source: asset.objectUrl, loading: false, error: undefined };
  if (blocked || !localPath) return { source: undefined, loading: false, error: undefined };
  if (!isTauriRuntime()) return { source: undefined, loading: false, error: undefined };
  return { source: convertFileSrc(localPath), loading: false, error: undefined };
}

async function createBufferedMediaUrl(path: string): Promise<string> {
  const response = await fetch(convertFileSrc(path));
  if (!response.ok) throw new Error(`Falha ao ler a mídia local (HTTP ${response.status})`);
  return URL.createObjectURL(await response.blob());
}

function AuxiliaryAudio({ item, asset, timelineTick, playing, onFailure }: { item: PlaybackItem; asset: MediaAsset; timelineTick: number; playing: boolean; onFailure: (asset: MediaAsset) => void }) {
  const mediaRef = useRef<HTMLAudioElement>(null);
  const itemRef = useRef(item);
  const timelineTickRef = useRef(timelineTick);
  const failureRef = useRef(onFailure);
  const mountedRef = useRef(true);
  const bufferedRef = useRef<{ path: string; url: string } | undefined>(undefined);
  const bufferAttemptsRef = useRef(new Set<string>());
  const bufferingPathRef = useRef<string | undefined>(undefined);
  const bufferRequestRef = useRef(0);
  const [failedProxyPath, setFailedProxyPath] = useState<string>();
  const [bufferedSource, setBufferedSource] = useState<{ path: string; url: string }>();
  const localSource = asset.proxyPath && asset.proxyPath !== failedProxyPath ? asset.proxyPath : asset.path;
  const directSource = resolveMediaSource(asset, localSource).source;
  const source = bufferedSource && bufferedSource.path === localSource ? bufferedSource.url : directSource;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bufferRequestRef.current += 1;
      if (bufferedRef.current) URL.revokeObjectURL(bufferedRef.current.url);
      bufferedRef.current = undefined;
    };
  }, []);

  const recoverSource = useCallback((): boolean => {
    if (!localSource || !isTauriRuntime()) return false;
    if (bufferingPathRef.current === localSource) return true;
    if (!bufferAttemptsRef.current.has(localSource)) {
      bufferAttemptsRef.current.add(localSource);
      bufferingPathRef.current = localSource;
      const requestId = ++bufferRequestRef.current;
      void createBufferedMediaUrl(localSource).then((url) => {
        if (!mountedRef.current || requestId !== bufferRequestRef.current) {
          bufferAttemptsRef.current.delete(localSource);
          URL.revokeObjectURL(url);
          return;
        }
        bufferingPathRef.current = undefined;
        if (bufferedRef.current) {
          bufferAttemptsRef.current.delete(bufferedRef.current.path);
          URL.revokeObjectURL(bufferedRef.current.url);
        }
        const next = { path: localSource, url };
        bufferedRef.current = next;
        setBufferedSource(next);
      }).catch(() => {
        bufferAttemptsRef.current.delete(localSource);
        if (!mountedRef.current || requestId !== bufferRequestRef.current) return;
        bufferingPathRef.current = undefined;
        if (asset.proxyPath === localSource && asset.path) setFailedProxyPath(asset.proxyPath);
        else failureRef.current(asset);
      });
      return true;
    }
    if (asset.proxyPath === localSource && asset.path) {
      setFailedProxyPath(asset.proxyPath);
      return true;
    }
    return false;
  }, [asset, localSource]);

  useEffect(() => {
    itemRef.current = item;
    timelineTickRef.current = timelineTick;
    failureRef.current = onFailure;
    const media = mediaRef.current;
    if (!media || !source) return;
    configureMediaElement(media, item, timelineTick);
  }, [item, onFailure, source, timelineTick]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !source) return;
    if (!playing) {
      media.pause();
      return;
    }
    configureMediaElement(media, itemRef.current, timelineTickRef.current);
    void media.play().catch(() => {
      if (!recoverSource()) failureRef.current(asset);
    });
  }, [asset, playing, recoverSource, source]);

  if (!source) return null;
  return <audio ref={mediaRef} className="auxiliary-audio" src={source} preload="auto" onError={() => {
    if (!recoverSource()) failureRef.current(asset);
  }} />;
}

function Viewer() {
  const editor = useEditor();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(editor.playheadTick);
  const playingRef = useRef(editor.isPlaying);
  const proxyAttemptsRef = useRef(new Set<string>());
  const bufferedFallbackAttemptsRef = useRef(new Set<string>());
  const bufferedSourceRef = useRef<{ path: string; url: string } | undefined>(undefined);
  const bufferRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const proxyingRef = useRef<string | undefined>(undefined);
  const actionsRef = useRef({ setError: editor.setError, setPlaying: editor.setPlaying, setPlayhead: editor.setPlayhead, setStatus: editor.setStatus });
  const [failedProxyPath, setFailedProxyPath] = useState<string>();
  const [bufferedSource, setBufferedSource] = useState<{ path: string; url: string }>();
  const [proxyingAssetId, setProxyingAssetId] = useState<string>();
  const [playbackError, setPlaybackError] = useState<string>();
  const [buffering, setBuffering] = useState(false);
  const [finalFrame, setFinalFrame] = useState<{ key: string; source: string }>();
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const sequence = activeSequence(editor.project);
  const captionStyle = sequence.captionStyle ?? DEFAULT_CAPTION_STYLE;
  const items = playbackItems(sequence);
  const frameTick = Math.round(editor.project.settings.timebase * editor.project.settings.fpsDen / editor.project.settings.fpsNum);
  const sequenceTicks = sequenceDuration(sequence);
  const totalTicks = Math.max(frameTick, sequenceTicks);
  const hasTimelineContent = sequenceTicks > 0;
  const programItems = items.filter((item) => {
    const itemAsset = editor.project.assets.find((candidate) => candidate.id === item.clip.assetId);
    if (!itemAsset || itemAsset.offline) return false;
    const visibleVideo = item.track.kind === "video" && !item.track.hidden && Boolean(itemAsset.width && itemAsset.height);
    const audible = !item.track.muted && itemAsset.hasAudio;
    return visibleVideo || audible;
  });
  const previewTick = programPreviewTick(editor.playheadTick, sequenceTicks, frameTick);
  const activeVideo = activeVideoPlaybackItem(programItems, previewTick);
  const activeAudio = activeAudioPlaybackItems(programItems, previewTick).filter((item) => editor.project.assets.some((asset) => asset.id === item.clip.assetId && asset.hasAudio));
  const active = activeVideo ?? activeAudio[0];
  const activeClipId = active?.clip.id;
  const previewItem = active;
  const previewClip = previewItem?.clip;
  const asset = resolvePlaybackAsset(editor.project.assets, previewClip?.assetId);
  const auxiliaryAudio = activeAudio.filter((item) => item.clip.id !== active?.clip.id);
  const caption = sequence.captions.find((item) => editor.playheadTick >= item.startTick && editor.playheadTick < item.endTick);
  const assetProxyJob = asset ? editor.jobs.find((job) => job.id === `proxy-${asset.id}` && job.state === "running") : undefined;
  const localSource = asset?.proxyPath && asset.proxyPath !== failedProxyPath ? asset.proxyPath : asset?.path;
  const previewMedia = resolveMediaSource(asset, localSource, Boolean(assetProxyJob && !asset?.proxyPath));
  const source = bufferedSource && bufferedSource.path === localSource ? bufferedSource.url : previewMedia.source;
  const sourceLoading = Boolean(assetProxyJob);
  const currentFrameKey = activeVideo && source ? `${activeVideo.clip.id}:${source}` : undefined;
  const showFinalFrame = Boolean(currentFrameKey && currentFrameKey === finalFrame?.key && !editor.isPlaying);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bufferRequestRef.current += 1;
      if (bufferedSourceRef.current) URL.revokeObjectURL(bufferedSourceRef.current.url);
      bufferedSourceRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    playheadRef.current = editor.playheadTick;
    playingRef.current = editor.isPlaying;
    actionsRef.current = { setError: editor.setError, setPlaying: editor.setPlaying, setPlayhead: editor.setPlayhead, setStatus: editor.setStatus };
  }, [editor.isPlaying, editor.playheadTick, editor.setError, editor.setPlaying, editor.setPlayhead, editor.setStatus]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const stopPlayback = () => {
    videoRef.current?.pause();
    editor.setPlaying(false);
    setBuffering(false);
  };

  const reportPlaybackFailure = (error?: unknown, mediaErrorCode?: number) => {
    const currentAsset = resolvePlaybackAsset(editor.project.assets, active?.clip.assetId, previewItem?.clip.assetId);
    const message = !isTauriRuntime() && currentAsset?.objectUrl
      ? `O navegador não consegue decodificar “${currentAsset.name}”. A geração de proxy usa o FFmpeg local e está disponível no aplicativo desktop.`
      : playbackFailureMessage(currentAsset?.name ?? "mídia", error, mediaErrorCode);
    setPlaybackError(message);
    setBuffering(false);
    actionsRef.current.setPlaying(false);
    actionsRef.current.setError(message);
  };

  const createPlaybackProxy = async (target: MediaAsset) => {
    if (!target.path || proxyAttemptsRef.current.has(target.id)) return;
    proxyAttemptsRef.current.add(target.id);
    proxyingRef.current = target.id;
    setProxyingAssetId(target.id);
    setPlaybackError(undefined);
    setBuffering(true);
    const jobId = `proxy-${target.id}`;
    editor.setJob({ id: jobId, kind: "proxy", label: `Proxy automático ${target.name}`, state: "running", progress: 0 });
    editor.setStatus(`Gerando proxy compatível para ${target.name}`);
    try {
      const proxyPath = await nativeApi.proxy(target.path, target.fingerprint);
      setFailedProxyPath(undefined);
      await editor.commit("Associar proxy automático", [{ type: "updateAsset", asset: { ...target, proxyPath } }]);
      editor.setJob({ id: jobId, kind: "proxy", label: `Proxy automático ${target.name}`, state: "completed", progress: 1 });
      editor.setStatus("Proxy compatível pronto; retomando reprodução");
    } catch (error) {
      const message = `Não foi possível gerar o proxy de “${target.name}”: ${errorMessage(error)}`;
      editor.setJob({ id: jobId, kind: "proxy", label: `Proxy automático ${target.name}`, state: "failed", progress: 0, detail: message });
      setPlaybackError(message);
      setBuffering(false);
      editor.setPlaying(false);
      editor.setError(message);
    } finally {
      proxyingRef.current = undefined;
      setProxyingAssetId(undefined);
    }
  };

  const bufferLocalSource = (target: MediaAsset, path: string): boolean => {
    if (bufferedFallbackAttemptsRef.current.has(path)) return false;
    bufferedFallbackAttemptsRef.current.add(path);
    const requestId = ++bufferRequestRef.current;
    setPlaybackError(undefined);
    setBuffering(true);
    editor.setStatus(`Preparando fallback compatível para ${target.name}`);
    void (async () => {
      try {
        const url = await createBufferedMediaUrl(path);
        if (!mountedRef.current || requestId !== bufferRequestRef.current) {
          bufferedFallbackAttemptsRef.current.delete(path);
          URL.revokeObjectURL(url);
          return;
        }
        if (bufferedSourceRef.current) {
          bufferedFallbackAttemptsRef.current.delete(bufferedSourceRef.current.path);
          URL.revokeObjectURL(bufferedSourceRef.current.url);
        }
        const nextSource = { path, url };
        bufferedSourceRef.current = nextSource;
        setBufferedSource(nextSource);
        setBuffering(false);
        editor.setStatus("Fonte compatível pronta; retomando reprodução");
      } catch (error) {
        bufferedFallbackAttemptsRef.current.delete(path);
        if (!mountedRef.current || requestId !== bufferRequestRef.current) return;
        setBuffering(false);
        if (target.proxyPath === path && target.path && path !== target.path) {
          setFailedProxyPath(target.proxyPath);
          editor.setStatus("Proxy indisponível; tentando o arquivo original");
          return;
        }
        reportPlaybackFailure(error);
      }
    })();
    return true;
  };

  const recoverPlaybackFailure = (error?: unknown, mediaErrorCode?: number): boolean => {
    const target = resolvePlaybackAsset(editor.project.assets, active?.clip.assetId, previewItem?.clip.assetId);
    if (!target) return false;
    const unsupported = (error instanceof DOMException && error.name === "NotSupportedError") || mediaErrorCode === 4 || mediaErrorCode === 3;
    const action = playbackRecoveryAction({
      asset: target,
      localSource,
      desktop: isTauriRuntime(),
      unsupported,
      proxyRunning: proxyingRef.current === target.id || editor.jobs.some((job) => job.id === `proxy-${target.id}` && job.state === "running"),
      proxyAttempted: proxyAttemptsRef.current.has(target.id),
      bufferedAttempted: Boolean(localSource && bufferedFallbackAttemptsRef.current.has(localSource)),
    });
    if (action === "wait") {
      setBuffering(true);
      return true;
    }
    if (action === "generate-proxy") {
      void createPlaybackProxy(target);
      return true;
    }
    if (action === "buffer-source" && localSource) return bufferLocalSource(target, localSource);
    if (action === "use-original" && target.proxyPath) {
      setFailedProxyPath(target.proxyPath);
      actionsRef.current.setStatus("Proxy indisponível; tentando o arquivo original");
      return true;
    }
    return false;
  };

  const requestPlayback = (media: HTMLMediaElement, item: PlaybackItem) => {
    setFinalFrame(undefined);
    configureMediaElement(media, item, playheadRef.current);
    setPlaybackError(undefined);
    setBuffering(media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
    const result = media.play();
    actionsRef.current.setPlaying(true);
    void result.catch((error) => {
      if (!recoverPlaybackFailure(error)) reportPlaybackFailure(error);
    });
  };

  const togglePlayback = () => {
    if (editor.isPlaying) {
      stopPlayback();
      return;
    }
    if (!hasTimelineContent) {
      const message = "A timeline ainda não contém clipes para reproduzir.";
      setPlaybackError(message);
      editor.setError(message);
      return;
    }
    if (editor.playheadTick >= sequenceTicks) {
      setPlaybackError(undefined);
      setFinalFrame(undefined);
      editor.setPlayhead(0);
      editor.setPlaying(true);
      return;
    }
    if (!active) {
      setPlaybackError(undefined);
      setBuffering(false);
      editor.setPlaying(true);
      return;
    }
    if (!source) {
      if (sourceLoading) {
        setBuffering(true);
        editor.setPlaying(true);
        return;
      }
      reportPlaybackFailure();
      return;
    }
    const media = videoRef.current;
    if (!media) {
      const message = "O monitor ainda está preparando a mídia. Tente reproduzir novamente.";
      setPlaybackError(message);
      editor.setError(message);
      return;
    }
    if (media.currentSrc !== source && media.src !== source) {
      media.src = source;
      media.load();
    }
    requestPlayback(media, active);
  };

  useEffect(() => {
    if (!editor.isPlaying || activeClipId || !hasTimelineContent || playheadRef.current >= sequenceTicks) return;
    const startedAt = performance.now();
    const startTick = playheadRef.current;
    let frame = 0;
    const advanceGap = (now: number) => {
      const elapsedTicks = Math.round((now - startedAt) / 1_000 * editor.project.settings.timebase);
      const nextTick = Math.min(sequenceTicks, startTick + elapsedTicks);
      actionsRef.current.setPlayhead(nextTick);
      if (nextTick >= sequenceTicks) actionsRef.current.setPlaying(false);
      else frame = requestAnimationFrame(advanceGap);
    };
    frame = requestAnimationFrame(advanceGap);
    return () => cancelAnimationFrame(frame);
  }, [activeClipId, editor.isPlaying, editor.project.settings.timebase, hasTimelineContent, sequenceTicks]);

  useEffect(() => {
    const media = videoRef.current;
    if (!media || !active || editor.isPlaying) return;
    configureMediaElement(media, active, previewTick);
    media.pause();
  }, [active, editor.isPlaying, previewTick, source]);

  useEffect(() => {
    if (hasTimelineContent && !editor.isPlaying && editor.playheadTick >= sequenceTicks) {
      scheduleAppSurfaceRefresh(120);
    }
  }, [editor.isPlaying, editor.playheadTick, hasTimelineContent, sequenceTicks]);

  useEffect(() => {
    const media = videoRef.current;
    if (!media || !editor.isPlaying || !active) return;
    configureMediaElement(media, active, playheadRef.current);
    const result = media.play();
    void result.catch((error) => {
      if (!recoverPlaybackFailure(error)) reportPlaybackFailure(error);
    });
    // Active clip/source changes are the only automatic continuation points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.clip.id, editor.isPlaying, source]);

  const advance = (from = active) => {
    if (!from) return;
    const end = Math.min(sequenceTicks, from.clip.startTick + from.clip.durationTicks);
    editor.setPlayhead(end);
    if (end >= sequenceTicks) stopPlayback();
  };

  const preserveFinalFrame = (media: HTMLVideoElement) => {
    if (!currentFrameKey || media.videoWidth <= 0 || media.videoHeight <= 0) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1920 / media.videoWidth);
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    try {
      context.drawImage(media, 0, 0, canvas.width, canvas.height);
      setFinalFrame({ key: currentFrameKey, source: canvas.toDataURL("image/jpeg", 0.92) });
    } catch {
      // Keep the native final frame if the media backend blocks canvas capture.
    }
  };

  const transform = previewClip?.transform;
  const elapsed = previewClip ? Math.max(0, editor.playheadTick - previewClip.startTick) : 0;
  const remaining = previewClip ? Math.max(0, previewClip.durationTicks - elapsed) : 0;
  const transitionInOpacity = previewClip?.transitionIn ? Math.min(1, elapsed / Math.max(1, previewClip.transitionIn.durationTicks)) : 1;
  const transitionOutOpacity = previewClip?.transitionOut ? Math.min(1, remaining / Math.max(1, previewClip.transitionOut.durationTicks)) : 1;
  const transitionOpacity = Math.min(transitionInOpacity, transitionOutOpacity);
  const programAspect = editor.project.settings.width / editor.project.settings.height;
  const frameWidth = stageSize.width > 0 ? Math.max(1, Math.min(stageSize.width - 28, (stageSize.height - 24) * programAspect)) : undefined;
  const frameHeight = frameWidth ? frameWidth / programAspect : undefined;
  const captionPreviewStyle: CSSProperties = {
    color: captionStyle.textColor,
    backgroundColor: captionStyle.background ? captionStyle.backgroundColor : "transparent",
    fontFamily: captionStyle.fontFamily === "mono" ? '"IBM Plex Mono", monospace' : captionStyle.fontFamily === "serif" ? "Georgia, serif" : "system-ui, sans-serif",
    fontSize: `${Math.max(10, Math.min(60, (frameHeight ?? editor.project.settings.height) * captionStyle.fontSize / editor.project.settings.height))}px`,
    fontWeight: captionStyle.bold ? 700 : 400,
    textTransform: captionStyle.uppercase ? "uppercase" : "none",
    top: captionStyle.position === "top" ? "9%" : captionStyle.position === "center" ? "50%" : "auto",
    bottom: captionStyle.position === "bottom" ? "9%" : "auto",
    transform: captionStyle.position === "center" ? "translateY(-50%)" : undefined,
  };
  const programMediaStyle: CSSProperties | undefined = transform ? {
    transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
    opacity: transform.opacity * transitionOpacity,
    filter: clipCssFilter(previewClip),
    clipPath: `inset(${transform.cropTop * 100}% ${transform.cropRight * 100}% ${transform.cropBottom * 100}% ${transform.cropLeft * 100}%)`,
  } : undefined;
  const seek = (tick: number) => {
    const bounded = Math.max(0, Math.min(totalTicks, tick));
    editor.setPlayhead(bounded);
    const boundedPreview = programPreviewTick(bounded, sequenceTicks, frameTick);
    const item = activePlaybackItem(programItems, boundedPreview);
    if (videoRef.current && item) configureMediaElement(videoRef.current, item, boundedPreview);
  };
  const pauseAndSeek = (tick: number) => {
    setFinalFrame(undefined);
    stopPlayback();
    seek(tick);
  };
  const reportAuxiliaryFailure = (failedAsset: MediaAsset) => {
    const message = playbackFailureMessage(failedAsset.name);
    setPlaybackError(message);
    actionsRef.current.setError(message);
    actionsRef.current.setPlaying(false);
  };
  const inTimelineGap = hasTimelineContent && !active;
  return (
    <section className="viewer" aria-label="Monitor de programa">
      <div className="viewer-head"><span>Programa</span><span className="viewer-source">{previewClip?.name ?? (inTimelineGap ? "Gap da timeline" : "Sem mídia")}</span><span>{editor.project.settings.width}×{editor.project.settings.height} · {editor.project.settings.fpsNum / editor.project.settings.fpsDen} fps</span></div>
      <div className="viewer-stage" ref={stageRef}>
        <div className="program-frame" style={{ width: frameWidth, height: frameHeight }}>
          {source ? (<>
            <video
            ref={videoRef}
            src={source}
            className={activeVideo ? undefined : "audio-engine"}
            preload="auto"
            playsInline
            onLoadedMetadata={() => {
              const media = videoRef.current;
              const item = active;
              if (!media || !item) return;
              configureMediaElement(media, item, playheadRef.current);
              if (playingRef.current) requestPlayback(media, item);
            }}
            onLoadStart={() => { setPlaybackError(undefined); setBuffering(playingRef.current); }}
            onWaiting={() => setBuffering(true)}
            onCanPlay={() => setBuffering(false)}
            onPlaying={() => { setFinalFrame(undefined); setBuffering(false); actionsRef.current.setPlaying(true); }}
            onError={(event) => {
              if (recoverPlaybackFailure(undefined, event.currentTarget.error?.code)) return;
              reportPlaybackFailure(undefined, event.currentTarget.error?.code);
            }}
            onEnded={(event) => { preserveFinalFrame(event.currentTarget); advance(); }}
            onTimeUpdate={(event) => {
              if (!editor.isPlaying || !active) return;
              const timelineTick = mediaSecondsToTimelineTick(active.clip, event.currentTarget.currentTime);
              if (timelineTick >= active.clip.startTick + active.clip.durationTicks) advance(active);
              else editor.setPlayhead(timelineTick);
            }}
            style={{ ...programMediaStyle, visibility: showFinalFrame ? "hidden" : undefined }}
            />
            {finalFrame && <img src={finalFrame.source} className={`video-snapshot ${showFinalFrame ? "visible" : ""}`} style={programMediaStyle} alt="" aria-hidden="true" />}
          </>) : <div className="viewer-empty"><Icon name="video" /><strong>{assetProxyJob ? "Gerando proxy compatível" : inTimelineGap ? "Gap da timeline" : "Nenhuma mídia no monitor"}</strong><span>{assetProxyJob ? "O vídeo será carregado automaticamente quando o proxy estiver pronto." : inTimelineGap ? "O programa permanece preto até o próximo clipe." : "Insira uma mídia na timeline para iniciar a edição."}</span></div>}
          {source && asset && !asset.width && <div className="viewer-audio"><Icon name="audio" /><strong>{asset.name}</strong><span>Pré-visualização de áudio</span></div>}
          {auxiliaryAudio.map((item) => {
            const audioAsset = editor.project.assets.find((candidate) => candidate.id === item.clip.assetId);
            return audioAsset ? <AuxiliaryAudio key={item.clip.id} item={item} asset={audioAsset} timelineTick={editor.playheadTick} playing={editor.isPlaying} onFailure={reportAuxiliaryFailure} /> : null;
          })}
          {(buffering || assetProxyJob || sourceLoading) && <div className="viewer-buffering" role="status"><span /> {proxyingAssetId || assetProxyJob ? "Gerando proxy compatível" : "Preparando mídia"}</div>}
          {playbackError && <div className="viewer-error" role="alert"><strong>Falha na reprodução</strong><span>{playbackError}</span><button className="text-button" onClick={togglePlayback}>Tentar novamente</button></div>}
          {caption && <div className="caption-preview" style={captionPreviewStyle}>{caption.text}</div>}
          <div className="safe-area" aria-hidden="true" />
        </div>
      </div>
      <div className="transport">
        <div className="transport-controls"><button className="icon-button" onClick={() => pauseAndSeek(editor.playheadTick - frameTick)} aria-label="Frame anterior" title="Frame anterior">−1</button><button className="transport-play" onClick={togglePlayback} disabled={!hasTimelineContent} aria-label={editor.isPlaying ? "Pausar" : "Reproduzir vídeo"} title={editor.isPlaying ? "Pausar (Espaço)" : "Reproduzir vídeo (Espaço)"}><Icon name={editor.isPlaying ? "pause" : "play"} /></button><button className="icon-button" onClick={() => pauseAndSeek(editor.playheadTick + frameTick)} aria-label="Próximo frame" title="Próximo frame">+1</button></div>
        <label className="program-scrubber"><span className="sr-only">Posição da reprodução</span><input type="range" min={0} max={totalTicks} step={frameTick} value={Math.min(editor.playheadTick, totalTicks)} onPointerDown={stopPlayback} onChange={(event) => pauseAndSeek(Number(event.target.value))} /></label>
        <div className="transport-time"><span className="timecode">{formatTimecode(editor.playheadTick, editor.project.settings.fpsNum, editor.project.settings.fpsDen)}</span><span>/ {formatTimecode(totalTicks, editor.project.settings.fpsNum, editor.project.settings.fpsDen)}</span></div>
      </div>
    </section>
  );
}

function ValueControl({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void }) {
  return <label className="value-control"><span>{label}</span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /><output>{Number.isInteger(value) ? value : value.toFixed(2)}</output></label>;
}

function InspectorPanel() {
  const editor = useEditor();
  const selected = selectedClipData(editor.project, editor.selection.clipIds);
  const asset = editor.project.assets.find((item) => item.id === editor.selection.assetId);
  const updateProjectSettings = (patch: Partial<typeof editor.project.settings>) => void editor.commit("Configurar sequência", [{ type: "setProjectSettings", settings: { ...editor.project.settings, ...patch } }]);
  if (!selected) return <div className="panel-content inspector-empty">{asset ? <><h3>{asset.name}</h3><dl><dt>Duração</dt><dd>{formatTimecode(asset.durationTicks)}</dd><dt>Dimensões</dt><dd>{asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}</dd><dt>Codec</dt><dd>{asset.codec ?? "—"}</dd><dt>Proxy</dt><dd>{asset.proxyPath ? "Ativo" : "Original"}</dd><dt>Transcrição</dt><dd>{editor.project.transcripts.some((item) => item.assetId === asset.id) ? "Disponível" : "Pendente"}</dd></dl></> : <div className="project-settings"><header><Icon name="settings" /><span><strong>Sequência ativa</strong><small>{activeSequence(editor.project).name}</small></span></header><label>Frame<select value={`${editor.project.settings.width}x${editor.project.settings.height}`} onChange={(event) => { const [width, height] = event.target.value.split("x").map(Number); updateProjectSettings({ width, height }); }}><option value="1920x1080">1920×1080</option><option value="3840x2160">3840×2160</option><option value="1080x1920">1080×1920</option><option value="1080x1080">1080×1080</option><option value="1280x720">1280×720</option></select></label><label>Frame rate<select value={`${editor.project.settings.fpsNum}/${editor.project.settings.fpsDen}`} onChange={(event) => { const [fpsNum, fpsDen] = event.target.value.split("/").map(Number); updateProjectSettings({ fpsNum, fpsDen }); }}><option value="24/1">24 fps</option><option value="25/1">25 fps</option><option value="30/1">30 fps</option><option value="30000/1001">29.97 fps</option><option value="60/1">60 fps</option></select></label><p>Selecione um asset ou clipe para inspecionar propriedades específicas.</p></div>}</div>;
  const { clip, track } = selected;
  const updateTransform = (key: keyof TimelineClip["transform"], value: number) => void editor.updateSelectedClip({ transform: { ...clip.transform, [key]: value } });
  return (
    <div className="panel-content inspector-panel">
      <div className="selection-title"><span>{track.name}</span><strong>{clip.name}</strong></div>
      <section className="inspector-section"><h3>Transform</h3><ValueControl label="Position X" value={clip.transform.x} min={-1920} max={1920} onChange={(value) => updateTransform("x", value)} /><ValueControl label="Position Y" value={clip.transform.y} min={-1080} max={1080} onChange={(value) => updateTransform("y", value)} /><ValueControl label="Scale" value={clip.transform.scale} min={0.1} max={4} step={0.05} onChange={(value) => updateTransform("scale", value)} /><ValueControl label="Rotation" value={clip.transform.rotation} min={-180} max={180} onChange={(value) => updateTransform("rotation", value)} /><ValueControl label="Opacity" value={clip.transform.opacity} min={0} max={1} step={0.01} onChange={(value) => updateTransform("opacity", value)} /></section>
      <section className="inspector-section"><h3>Crop</h3><ValueControl label="Top" value={clip.transform.cropTop} min={0} max={0.49} step={0.01} onChange={(value) => updateTransform("cropTop", value)} /><ValueControl label="Right" value={clip.transform.cropRight} min={0} max={0.49} step={0.01} onChange={(value) => updateTransform("cropRight", value)} /><ValueControl label="Bottom" value={clip.transform.cropBottom} min={0} max={0.49} step={0.01} onChange={(value) => updateTransform("cropBottom", value)} /><ValueControl label="Left" value={clip.transform.cropLeft} min={0} max={0.49} step={0.01} onChange={(value) => updateTransform("cropLeft", value)} /></section>
      <section className="inspector-section"><h3>Time & Audio</h3><ValueControl label="Speed" value={clip.speed} min={0.25} max={4} step={0.05} onChange={(value) => void editor.updateSelectedClip({ speed: value })} /><ValueControl label="Volume" value={clip.volume} min={0} max={2} step={0.01} onChange={(value) => void editor.updateSelectedClip({ volume: value })} /></section>
      {(clip.transitionIn || clip.transitionOut) && <section className="inspector-section"><h3>Transitions</h3>{clip.transitionIn && <ValueControl label={`${clip.transitionIn.kind} IN`} value={ticksToSeconds(clip.transitionIn.durationTicks)} min={0.05} max={3} step={0.05} onChange={(value) => void editor.updateSelectedClip({ transitionIn: { ...clip.transitionIn!, durationTicks: secondsToTicks(value) } })} />}{clip.transitionOut && <ValueControl label={`${clip.transitionOut.kind} OUT`} value={ticksToSeconds(clip.transitionOut.durationTicks)} min={0.05} max={3} step={0.05} onChange={(value) => void editor.updateSelectedClip({ transitionOut: { ...clip.transitionOut!, durationTicks: secondsToTicks(value) } })} />}</section>}
      <section className="inspector-section"><h3>Effects <span>{clip.effects.length}</span></h3>{clip.effects.length === 0 ? <p>Nenhum efeito aplicado.</p> : clip.effects.map((effect) => <div className="effect-control" key={effect.id}><ValueControl label={effect.kind} value={effect.value} min={-1} max={1} step={0.01} onChange={(value) => void editor.updateSelectedClip({ effects: clip.effects.map((item) => item.id === effect.id ? { ...item, value } : item) })} /><button className="icon-button" onClick={() => void editor.updateSelectedClip({ effects: clip.effects.filter((item) => item.id !== effect.id) })} title="Remover efeito" aria-label={`Remover ${effect.kind}`}><Icon name="trash" /></button></div>)}</section>
    </div>
  );
}

const chatStarters = [
  "Corte a introdução",
  "Remova as pausas longas",
  "Crie legendas a partir da transcrição",
];

function ChatPanel() {
  const editor = useEditor();
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const cancelledRef = useRef(false);
  const busy = editor.agentSteps.some((step) => step.state === "running");
  useEffect(() => {
    const messages = messagesRef.current;
    if (!messages) return;
    messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
  }, [editor.messages, editor.agentSteps]);

  const configureKey = async () => {
    if (!apiKey.trim() || !isTauriRuntime()) return;
    try {
      await nativeApi.setGeminiKey(apiKey.trim());
      setApiKey("");
      setShowKey(false);
      editor.setStatus("Chave Gemini disponível nesta sessão");
    } catch (error) {
      editor.setError(errorMessage(error));
    }
  };

  const fillStarter = (text: string) => {
    setPrompt(text);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    cancelledRef.current = false;
    setPrompt("");
    editor.addMessage("user", text);
    const total = sequenceDuration(activeSequence(editor.project));
    const steps = [
      { id: createId("step"), label: "Ler transcript e timeline", state: "running" as const, range: { startTick: 0, endTick: total } },
      { id: createId("step"), label: "Decidir próximo passo", state: "queued" as const },
      { id: createId("step"), label: "Aplicar transação", state: "queued" as const },
    ];
    editor.setAgentSteps(steps);
    if (!isTauriRuntime()) {
      editor.setAgentSteps(steps.map((step, index) => ({ ...step, state: index === 0 ? "completed" as const : "cancelled" as const })));
      editor.addMessage("assistant", "A interface está em modo web. Execute o aplicativo Tauri e configure a chave Gemini para aplicar edições pelo agente.");
      return;
    }
    try {
      editor.setAgentSteps(steps.map((step, index) => ({ ...step, state: index === 1 ? "running" as const : index < 1 ? "completed" as const : step.state })));
      const plan = await nativeApi.planEdit(resolveRetryPrompt(text, editor.messages), editor.project, editor.messages, editor.selection);
      if (cancelledRef.current) {
        editor.setAgentSteps(steps.map((step) => ({ ...step, state: "cancelled" as const })));
        editor.addMessage("assistant", "Operação cancelada antes de alterar a timeline.");
        return;
      }
      if (plan.question) {
        editor.setAgentSteps(steps.map((step, index) => ({
          ...step,
          label: index === 2 ? "Pergunta enviada" : step.label,
          state: "completed" as const,
        })));
        editor.addMessage("assistant", formatAgentQuestion(plan.question));
        requestAnimationFrame(() => composerRef.current?.focus());
        return;
      }
      editor.setAgentSteps(steps.map((step, index) => ({ ...step, state: index === 2 ? "running" as const : index < 2 ? "completed" as const : step.state })));
      if (plan.operations.length) await editor.commit("Edição do agente", plan.operations, "agent");
      editor.setAgentSteps(steps.map((step) => ({ ...step, state: "completed" as const })));
      editor.addMessage("assistant", plan.message);
    } catch (error) {
      if (cancelledRef.current) return;
      editor.setAgentSteps(steps.map((step) => step.state === "running" ? { ...step, state: "failed" as const } : step));
      editor.addMessage("assistant", `Não foi possível concluir a edição: ${errorMessage(error)}`);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-settings">
        <div className="chat-config">
          <span>Gemini usa somente texto</span>
          <button className="text-link" onClick={() => setShowKey(!showKey)}>Chave da sessão</button>
        </div>
        {showKey && <div className="key-entry"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="GEMINI_API_KEY" /><button className="text-button" onClick={() => void configureKey()}>Aplicar</button></div>}
      </div>
      <div ref={messagesRef} className="messages" aria-live="polite">
        {editor.messages.length === 0 && <div className="empty-chat">
          <div className="empty-chat-intro"><span className="empty-chat-icon"><Icon name="chat" /></span><div><strong>Descreva a edição</strong><p>O agente usa a transcrição, a seleção e a timeline. Se faltar uma decisão importante, ele pergunta antes de editar.</p></div></div>
          <div className="chat-starters"><span>Experimente</span>{chatStarters.map((starter) => <button key={starter} type="button" className="chat-starter" onClick={() => fillStarter(starter)}>{starter}</button>)}</div>
        </div>}
        {editor.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "Você" : message.role === "assistant" ? "Gemini" : "Sistema"}</span><p>{message.text}</p></article>)}
        {editor.agentSteps.length > 0 && <div className="agent-ledger">{editor.agentSteps.map((step) => <div key={step.id} data-state={step.state}><span className="step-indicator" /><span>{step.label}</span><small>{step.state}</small></div>)}</div>}
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea ref={composerRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Descreva o resultado desejado" rows={3} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <div><span>Enter envia · Shift+Enter quebra linha</span>{busy ? <button type="button" className="stop-button" onClick={() => { cancelledRef.current = true; editor.setAgentSteps(editor.agentSteps.map((step) => step.state === "running" || step.state === "queued" ? { ...step, state: "cancelled" } : step)); }}><Icon name="stop" /> Stop</button> : <button className="send-button" aria-label="Enviar"><Icon name="send" /></button>}</div>
      </form>
    </div>
  );
}

function RightPanel() {
  const editor = useEditor();
  return (
    <aside className="right-panel" aria-label="Inspector e agente">
      <nav className="right-tabs"><button className={editor.rightTab === "inspector" ? "active" : ""} onClick={() => editor.setRightTab("inspector")}><Icon name="inspector" /> Inspector</button><button className={editor.rightTab === "chat" ? "active" : ""} onClick={() => editor.setRightTab("chat")}><Icon name="chat" /> Chat</button></nav>
      {editor.rightTab === "inspector" ? <InspectorPanel /> : <ChatPanel />}
    </aside>
  );
}

function StatusBar() {
  const editor = useEditor();
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void nativeApi.runtimeStatus(localStorage.getItem("whisperModelPath") ?? undefined).then(setRuntime).catch(() => undefined);
  }, []);
  const activeJobs = editor.jobs.filter((job) => job.state === "running");
  return <footer className="statusbar"><div>{activeJobs.length ? activeJobs.map((job) => <span key={job.id} className="job-status"><i style={{ width: `${job.progress * 100}%` }} />{job.label}</span>) : editor.status}</div><div><span className={isTauriRuntime() ? "runtime-ok" : "runtime-missing"}>{isTauriRuntime() ? "Desktop" : "Preview web"}</span>{runtime && <><span className={runtime.ffmpeg.available && runtime.ffprobe.available ? "runtime-ok" : "runtime-missing"} title={`${runtime.ffmpeg.detail} · ${runtime.ffprobe.detail}`}>FFmpeg</span><span className={runtime.youtube.available ? "runtime-ok" : "runtime-missing"} title={runtime.youtube.detail}>YouTube</span><span className={runtime.whisper.available && runtime.model.available ? "runtime-ok" : "runtime-missing"} title={`${runtime.whisper.detail} · ${runtime.model.detail}`}>Whisper</span></>}<span>Rev {editor.project.revision}</span><span>{editor.project.assets.length} assets</span></div></footer>;
}

export function Workspace() {
  const editor = useEditor();
  const workspaceRef = useRef<HTMLElement>(null);
  const [modelPath, setModelPath] = useState(() => localStorage.getItem("whisperModelPath") ?? "");
  const { schedule: scheduleAutomaticTranscription, resumePending } = useAutomaticTranscription(editor, modelPath);
  const updateModelPath = useCallback((path: string) => {
    if (path) localStorage.setItem("whisperModelPath", path);
    else localStorage.removeItem("whisperModelPath");
    setModelPath(path);
    resumePending(path);
  }, [resumePending]);
  const [layout, setLayout] = useState(() => ({ left: window.innerWidth <= 1280 ? 235 : 280, right: window.innerWidth <= 1280 ? 315 : 360, upper: undefined as number | undefined }));
  const resizeBy = (edge: "left" | "right" | "horizontal", delta: number) => {
    const height = workspaceRef.current?.clientHeight ?? 700;
    setLayout((current) => edge === "left"
      ? { ...current, left: Math.min(420, Math.max(220, current.left + delta)) }
      : edge === "right"
        ? { ...current, right: Math.min(480, Math.max(280, current.right - delta)) }
        : { ...current, upper: Math.min(height - 230, Math.max(260, (current.upper ?? height * 0.53) + delta)) });
  };
  const beginResize = (edge: "left" | "right" | "horizontal", event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = layout;
    const height = workspaceRef.current?.clientHeight ?? 700;
    const move = (pointer: PointerEvent) => {
      if (edge === "left") setLayout({ ...start, left: Math.min(420, Math.max(220, start.left + pointer.clientX - startX)) });
      else if (edge === "right") setLayout({ ...start, right: Math.min(480, Math.max(280, start.right - pointer.clientX + startX)) });
      else setLayout({ ...start, upper: Math.min(height - 230, Math.max(260, (start.upper ?? height * 0.53) + pointer.clientY - startY)) });
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) void editor.redo();
        else void editor.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); void editor.redo(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); void editor.duplicateSelected(); return; }
      if (event.code === "Space") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".transport-play")?.click();
        return;
      }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); void editor.splitSelected(); return; }
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); void editor.deleteSelected(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor]);
  return (
    <div className="app-shell">
      <TopBar />
      <main ref={workspaceRef} className="workspace-grid" style={{ "--left-panel": `${layout.left}px`, "--right-panel": `${layout.right}px`, "--upper-height": layout.upper ? `${layout.upper}px` : "53%" } as CSSProperties}>
        <LeftPanel modelPath={modelPath} onModelPathChange={updateModelPath} scheduleAutomaticTranscription={scheduleAutomaticTranscription} />
        <Viewer />
        <RightPanel />
        <Timeline />
        <div className="panel-resizer left-resizer" role="separator" aria-label="Redimensionar painel esquerdo" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginResize("left", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resizeBy("left", -10); if (event.key === "ArrowRight") resizeBy("left", 10); }} />
        <div className="panel-resizer right-resizer" role="separator" aria-label="Redimensionar painel direito" aria-orientation="vertical" tabIndex={0} onPointerDown={(event) => beginResize("right", event)} onKeyDown={(event) => { if (event.key === "ArrowLeft") resizeBy("right", -10); if (event.key === "ArrowRight") resizeBy("right", 10); }} />
        <div className="panel-resizer horizontal-resizer" role="separator" aria-label="Redimensionar timeline" aria-orientation="horizontal" tabIndex={0} onPointerDown={(event) => beginResize("horizontal", event)} onKeyDown={(event) => { if (event.key === "ArrowUp") resizeBy("horizontal", -10); if (event.key === "ArrowDown") resizeBy("horizontal", 10); }} />
      </main>
      <StatusBar />
      {editor.error && <div className="error-toast" role="alert"><span>{editor.error}</span><button className="icon-button" onClick={() => editor.setError()} aria-label="Fechar erro"><Icon name="close" /></button></div>}
    </div>
  );
}
