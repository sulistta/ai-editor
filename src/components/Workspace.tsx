import { type CSSProperties, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEditor } from "../context/EditorContext";
import { activePlaybackItem, mediaVolume, playbackFailureMessage, playbackItemAtOrAfter, playbackItems, resolvePlaybackAsset, timelineTickToMediaSeconds, type PlaybackItem } from "../lib/playback";
import { activeSequence, captionsFromTranscript, createId, sequenceDuration } from "../lib/project";
import { chooseExportPath, chooseMediaPaths, chooseProjectOpenPath, chooseProjectPath, chooseWhisperModelPath, errorMessage, isTauriRuntime, nativeApi } from "../lib/tauri";
import { formatTimecode, secondsToTicks, ticksToSeconds } from "../lib/time";
import type { CaptionCue, EffectInstance, MediaAsset, RuntimeStatus, TimelineClip } from "../types";
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

function MediaPanel() {
  const editor = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [showUrlImport, setShowUrlImport] = useState(false);
  const [downloadingUrl, setDownloadingUrl] = useState(false);
  const [modelPath, setModelPath] = useState(() => localStorage.getItem("whisperModelPath") ?? "");
  const filtered = editor.project.assets.filter((asset) => asset.name.toLowerCase().includes(query.toLowerCase()));

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
        if (asset.width && asset.height) void createProxy(asset);
      } catch (error) {
        editor.setError(errorMessage(error));
      }
    }
  };

  const onBrowserFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) await editor.importAsset(await probeBrowserFile(file));
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
      if (asset.width && asset.height) void createProxy(asset);
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

  const transcribe = async (asset: MediaAsset) => {
    if (!asset.path || !isTauriRuntime()) {
      editor.setStatus("A transcrição local requer o aplicativo desktop e um arquivo com caminho local");
      return;
    }
    const jobId = `transcription-${asset.id}`;
    editor.setJob({ id: jobId, kind: "transcription", label: `Transcrever ${asset.name}`, state: "running", progress: 0 });
    try {
      const transcript = await nativeApi.transcribe({ assetId: asset.id, mediaPath: asset.path, modelPath: modelPath || undefined });
      await editor.setTranscript(transcript);
      editor.setJob({ id: jobId, kind: "transcription", label: `Transcrever ${asset.name}`, state: "completed", progress: 1 });
      editor.setStatus("Transcrição local concluída");
    } catch (error) {
      editor.setJob({ id: jobId, kind: "transcription", label: `Transcrever ${asset.name}`, state: "failed", progress: 0, detail: errorMessage(error) });
      editor.setError(errorMessage(error));
    }
  };

  const relink = async (asset: MediaAsset) => {
    const [path] = await chooseMediaPaths();
    if (!path) return;
    try {
      const replacement = await nativeApi.import(path, path.split(/[\\/]/).at(-1) ?? asset.name);
      await editor.commit("Relink de mídia", [{ type: "updateAsset", asset: { ...replacement, id: asset.id } }]);
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
    localStorage.setItem("whisperModelPath", path);
    setModelPath(path);
    editor.setStatus("Modelo whisper.cpp configurado");
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
              <div className="asset-actions"><button className={`asset-status ${asset.proxyPath ? "ready" : ""}`} disabled={asset.offline || !asset.width} onClick={(event) => { event.stopPropagation(); void createProxy(asset); }} title={asset.proxyPath ? "Proxy disponível" : "Gerar proxy 720p"} aria-label={`Gerar proxy de ${asset.name}`}><Icon name="settings" /></button><button className={`asset-status ${transcript ? "ready" : ""}`} onClick={(event) => { event.stopPropagation(); if (asset.offline) void relink(asset); else void transcribe(asset); }} title={asset.offline ? "Relink de mídia" : transcript ? "Transcrição disponível" : "Transcrever localmente"} aria-label={asset.offline ? `Relink ${asset.name}` : transcript ? "Transcrição disponível" : `Transcrever ${asset.name}`}><Icon name={asset.offline ? "open" : "transcript"} /></button></div>
            </article>
          );
        })}
      </div>
      {filtered.length > 0 && <p className="panel-hint">Clique duas vezes para inserir na timeline.</p>}
      <div className="local-model"><span><Icon name="settings" /><span><strong>whisper.cpp local</strong><small>{modelPath ? modelPath.split(/[\\/]/).at(-1) : "Modelo automático ou WHISPER_MODEL_PATH"}</small></span></span><button className="text-button" onClick={() => void chooseModel()} disabled={!isTauriRuntime()}>Modelo</button></div>
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
  return (
    <div className="panel-content captions-panel">
      <div className="panel-action-row"><button className="primary-button compact" disabled={!transcript} onClick={() => void createCaptions()}><Icon name="captions" /> Do transcript</button><button className="text-button" onClick={() => void addCaption()}><Icon name="plus" /> Manual</button></div>
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

function LeftPanel() {
  const editor = useEditor();
  return (
    <aside className="left-panel" aria-label="Biblioteca e ferramentas">
      <nav className="panel-tabs" aria-label="Ferramentas">
        {leftTabs.map((tab) => <button key={tab.id} className={editor.leftTab === tab.id ? "active" : ""} onClick={() => editor.setLeftTab(tab.id)} title={tab.label}><Icon name={tab.icon} /><span>{tab.label}</span></button>)}
      </nav>
      <div className="panel-heading"><h2>{leftTabs.find((tab) => tab.id === editor.leftTab)?.label}</h2><button className="icon-button" aria-label="Opções do painel"><Icon name="settings" /></button></div>
      {editor.leftTab === "media" && <MediaPanel />}
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

function useResolvedMediaSource(asset: MediaAsset | undefined, localPath: string | undefined, blocked = false) {
  const [loaded, setLoaded] = useState<{ path: string; url?: string; error?: string }>();

  useEffect(() => {
    if (asset?.objectUrl || !localPath || blocked || !isTauriRuntime()) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    void fetch(convertFileSrc(localPath))
      .then((response) => {
        if (!response.ok) throw new Error(`Falha ao ler mídia (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ path: localPath, url: objectUrl });
      })
      .catch((error) => {
        if (!cancelled) setLoaded({ path: localPath, error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset?.objectUrl, blocked, localPath]);

  if (asset?.objectUrl) return { source: asset.objectUrl, loading: false, error: undefined };
  if (blocked || !localPath) return { source: undefined, loading: false, error: undefined };
  if (!isTauriRuntime()) return { source: undefined, loading: false, error: undefined };
  if (loaded?.path === localPath) return { source: loaded.url, loading: !loaded.url && !loaded.error, error: loaded.error };
  return { source: undefined, loading: true, error: undefined };
}

function Viewer() {
  const editor = useEditor();
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(editor.playheadTick);
  const playingRef = useRef(editor.isPlaying);
  const proxyAttemptsRef = useRef(new Set<string>());
  const proxyingRef = useRef<string | undefined>(undefined);
  const actionsRef = useRef({ setError: editor.setError, setPlaying: editor.setPlaying, setPlayhead: editor.setPlayhead, setStatus: editor.setStatus });
  const [failedProxyPath, setFailedProxyPath] = useState<string>();
  const [proxyingAssetId, setProxyingAssetId] = useState<string>();
  const [playbackError, setPlaybackError] = useState<string>();
  const [buffering, setBuffering] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const sequence = activeSequence(editor.project);
  const selected = selectedClipData(editor.project, editor.selection.clipIds);
  const items = playbackItems(sequence);
  const active = activePlaybackItem(items, editor.playheadTick);
  const upcoming = playbackItemAtOrAfter(items, editor.playheadTick);
  const selectedItem = selected ? { clip: selected.clip, track: selected.track, trackIndex: sequence.tracks.indexOf(selected.track) } : undefined;
  const previewItem = active ?? selectedItem ?? upcoming;
  const previewClip = previewItem?.clip;
  const asset = resolvePlaybackAsset(editor.project.assets, previewClip?.assetId, editor.selection.assetId);
  const caption = sequence.captions.find((item) => editor.playheadTick >= item.startTick && editor.playheadTick <= item.endTick);
  const assetProxyJob = asset ? editor.jobs.find((job) => job.id === `proxy-${asset.id}` && job.state === "running") : undefined;
  const localSource = asset?.proxyPath && asset.proxyPath !== failedProxyPath ? asset.proxyPath : asset?.path;
  const previewMedia = useResolvedMediaSource(asset, localSource, Boolean(assetProxyJob && !asset?.proxyPath));
  const source = previewMedia.source;
  const playbackCandidate = active ?? upcoming;
  const playbackAsset = editor.project.assets.find((item) => item.id === playbackCandidate?.clip.assetId);
  const playbackProxyJob = playbackAsset ? editor.jobs.find((job) => job.id === `proxy-${playbackAsset.id}` && job.state === "running") : undefined;
  const playbackLocalSource = playbackAsset?.proxyPath && playbackAsset.proxyPath !== failedProxyPath ? playbackAsset.proxyPath : playbackAsset?.path;
  const playbackUsesPreview = playbackAsset?.id === asset?.id;
  const alternatePlaybackMedia = useResolvedMediaSource(playbackUsesPreview ? undefined : playbackAsset, playbackUsesPreview ? undefined : playbackLocalSource, Boolean(playbackProxyJob && !playbackAsset?.proxyPath));
  const playbackSource = playbackUsesPreview ? source : alternatePlaybackMedia.source;
  const sourceLoading = previewMedia.loading || (!playbackUsesPreview && alternatePlaybackMedia.loading);
  const sourceLoadError = previewMedia.error ?? alternatePlaybackMedia.error;

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
    const currentAsset = resolvePlaybackAsset(editor.project.assets, active?.clip.assetId, playbackCandidate?.clip.assetId, previewItem?.clip.assetId, editor.selection.assetId);
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

  const recoverPlaybackFailure = (error?: unknown, mediaErrorCode?: number): boolean => {
    const target = resolvePlaybackAsset(editor.project.assets, active?.clip.assetId, playbackCandidate?.clip.assetId, previewItem?.clip.assetId, editor.selection.assetId);
    if (!target) return false;
    if (proxyingRef.current === target.id) return true;
    if (editor.jobs.some((job) => job.id === `proxy-${target.id}` && job.state === "running")) {
      setBuffering(true);
      return true;
    }
    const unsupported = (error instanceof DOMException && error.name === "NotSupportedError") || mediaErrorCode === 4 || mediaErrorCode === 3;
    const legacyProxyFailed = Boolean(target.proxyPath && target.proxyPath === localSource && !target.proxyPath.includes(".proxy-v2."));
    if (unsupported && target.path && isTauriRuntime() && (!target.proxyPath || legacyProxyFailed) && !proxyAttemptsRef.current.has(target.id)) {
      void createPlaybackProxy(target);
      return true;
    }
    return false;
  };

  const requestPlayback = (media: HTMLMediaElement, item: PlaybackItem) => {
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
    if (!playbackCandidate || !playbackSource) {
      const message = "Não há mídia disponível para reproduzir nesta posição da timeline.";
      setPlaybackError(message);
      editor.setError(message);
      return;
    }
    const media = videoRef.current;
    if (!media) {
      const message = "O monitor ainda está preparando a mídia. Tente reproduzir novamente.";
      setPlaybackError(message);
      editor.setError(message);
      return;
    }
    if (!active) editor.setPlayhead(playbackCandidate.clip.startTick);
    if (media.currentSrc !== playbackSource && media.src !== playbackSource) {
      media.src = playbackSource;
      media.load();
    }
    requestPlayback(media, playbackCandidate);
  };

  useEffect(() => {
    if (!editor.isPlaying || active) return;
    const next = playbackItemAtOrAfter(playbackItems(sequence), editor.playheadTick);
    if (next) actionsRef.current.setPlayhead(next.clip.startTick);
    else actionsRef.current.setPlaying(false);
  }, [active, editor.isPlaying, editor.playheadTick, sequence]);

  useEffect(() => {
    const media = videoRef.current;
    if (!media || !previewItem || editor.isPlaying) return;
    configureMediaElement(media, previewItem, editor.playheadTick);
    media.pause();
  }, [editor.isPlaying, editor.playheadTick, previewItem, source]);

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

  const advance = (from = active ?? previewItem) => {
    if (!from) return;
    const end = from.clip.startTick + from.clip.durationTicks;
    const next = playbackItemAtOrAfter(items, end);
    if (next) editor.setPlayhead(Math.max(end, next.clip.startTick));
    else stopPlayback();
  };

  const transform = previewClip?.transform;
  const elapsed = previewClip ? Math.max(0, editor.playheadTick - previewClip.startTick) : 0;
  const remaining = previewClip ? Math.max(0, previewClip.durationTicks - elapsed) : 0;
  const transitionInOpacity = previewClip?.transitionIn ? Math.min(1, elapsed / Math.max(1, previewClip.transitionIn.durationTicks)) : 1;
  const transitionOutOpacity = previewClip?.transitionOut ? Math.min(1, remaining / Math.max(1, previewClip.transitionOut.durationTicks)) : 1;
  const transitionOpacity = Math.min(transitionInOpacity, transitionOutOpacity);
  const frameTick = Math.round(editor.project.settings.timebase * editor.project.settings.fpsDen / editor.project.settings.fpsNum);
  const totalTicks = Math.max(frameTick, sequenceDuration(sequence));
  const programAspect = editor.project.settings.width / editor.project.settings.height;
  const frameWidth = stageSize.width > 0 ? Math.max(1, Math.min(stageSize.width - 28, (stageSize.height - 24) * programAspect)) : undefined;
  const frameHeight = frameWidth ? frameWidth / programAspect : undefined;
  const seek = (tick: number) => {
    const bounded = Math.max(0, Math.min(totalTicks, tick));
    editor.setPlayhead(bounded);
    const item = activePlaybackItem(items, bounded);
    if (videoRef.current && item) configureMediaElement(videoRef.current, item, bounded);
  };
  return (
    <section className="viewer" aria-label="Monitor de programa">
      <div className="viewer-head"><span>Programa</span><span className="viewer-source">{previewClip?.name ?? asset?.name ?? "Sem mídia"}</span><span>{editor.project.settings.width}×{editor.project.settings.height} · {editor.project.settings.fpsNum / editor.project.settings.fpsDen} fps</span></div>
      <div className="viewer-stage" ref={stageRef}>
        <div className="program-frame" style={{ width: frameWidth, height: frameHeight }}>
          {source ? (
            <video
            ref={videoRef}
            src={source}
            className={asset?.width && asset.height ? undefined : "audio-engine"}
            preload="auto"
            playsInline
            onLoadedMetadata={() => {
              const media = videoRef.current;
              const item = active ?? previewItem;
              if (!media || !item) return;
              configureMediaElement(media, item, playheadRef.current);
              if (playingRef.current && active) requestPlayback(media, active);
            }}
            onLoadStart={() => { setPlaybackError(undefined); setBuffering(playingRef.current); }}
            onWaiting={() => setBuffering(true)}
            onCanPlay={() => setBuffering(false)}
            onPlaying={() => { setBuffering(false); actionsRef.current.setPlaying(true); }}
            onError={(event) => {
              if (recoverPlaybackFailure(undefined, event.currentTarget.error?.code)) return;
              if (asset?.proxyPath && asset.proxyPath !== failedProxyPath && asset.path) {
                setFailedProxyPath(asset.proxyPath);
                actionsRef.current.setStatus("Proxy indisponível; tentando o arquivo original");
                return;
              }
              reportPlaybackFailure(undefined, event.currentTarget.error?.code);
            }}
            onEnded={() => advance()}
            onTimeUpdate={(event) => {
              if (!previewClip || !editor.isPlaying || !active) return;
              const timelineTick = previewClip.startTick + Math.round((secondsToTicks(event.currentTarget.currentTime) - previewClip.sourceInTick) / previewClip.speed);
              if (timelineTick >= previewClip.startTick + previewClip.durationTicks) advance();
              else editor.setPlayhead(Math.max(previewClip.startTick, timelineTick));
            }}
            style={transform ? {
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
              opacity: transform.opacity * transitionOpacity,
              filter: clipCssFilter(previewClip),
              clipPath: `inset(${transform.cropTop * 100}% ${transform.cropRight * 100}% ${transform.cropBottom * 100}% ${transform.cropLeft * 100}%)`,
            } : undefined}
            />
          ) : <div className="viewer-empty"><Icon name="video" /><strong>{assetProxyJob ? "Gerando proxy compatível" : sourceLoading ? "Carregando mídia local" : "Nenhuma mídia no monitor"}</strong><span>{assetProxyJob ? "O vídeo será carregado automaticamente quando o proxy estiver pronto." : sourceLoading ? "Preparando uma fonte compatível com o monitor." : "Selecione um asset ou posicione o playhead sobre um clipe."}</span></div>}
          {source && asset && !asset.width && <div className="viewer-audio"><Icon name="audio" /><strong>{asset.name}</strong><span>Pré-visualização de áudio</span></div>}
          {(buffering || assetProxyJob || sourceLoading) && <div className="viewer-buffering" role="status"><span /> {proxyingAssetId || assetProxyJob ? "Gerando proxy compatível" : "Preparando mídia"}</div>}
          {(playbackError || sourceLoadError) && <div className="viewer-error" role="alert"><strong>Falha na reprodução</strong><span>{playbackError ?? `Não foi possível carregar a mídia local: ${sourceLoadError}`}</span><button className="text-button" onClick={togglePlayback}>Tentar novamente</button></div>}
          {caption && <div className="caption-preview">{caption.text}</div>}
          <div className="safe-area" aria-hidden="true" />
        </div>
      </div>
      <div className="transport">
        <div className="transport-controls"><button className="icon-button" onClick={() => seek(editor.playheadTick - frameTick)} aria-label="Frame anterior" title="Frame anterior">−1</button><button className="transport-play" onClick={togglePlayback} disabled={!playbackCandidate || !playbackSource} aria-label={editor.isPlaying ? "Pausar" : "Reproduzir vídeo"} title={editor.isPlaying ? "Pausar (Espaço)" : "Reproduzir vídeo (Espaço)"}><Icon name={editor.isPlaying ? "pause" : "play"} /></button><button className="icon-button" onClick={() => seek(editor.playheadTick + frameTick)} aria-label="Próximo frame" title="Próximo frame">+1</button></div>
        <label className="program-scrubber"><span className="sr-only">Posição da reprodução</span><input type="range" min={0} max={totalTicks} step={frameTick} value={Math.min(editor.playheadTick, totalTicks)} onPointerDown={stopPlayback} onChange={(event) => seek(Number(event.target.value))} /></label>
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

const visualTerms = ["olhar", "rosto", "cor do", "aparece", "imagem", "enquadramento", "objeto"];

function ChatPanel() {
  const editor = useEditor();
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);
  const busy = editor.agentSteps.some((step) => step.state === "running");
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [editor.messages]);

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

  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    cancelledRef.current = false;
    setPrompt("");
    editor.addMessage("user", text);
    const total = sequenceDuration(activeSequence(editor.project));
    const steps = [
      { id: createId("step"), label: "Ler transcript e timeline", state: "running" as const, range: { startTick: 0, endTick: total } },
      { id: createId("step"), label: "Planejar operações", state: "queued" as const },
      { id: createId("step"), label: "Aplicar transação", state: "queued" as const },
    ];
    editor.setAgentSteps(steps);
    if (visualTerms.some((term) => text.toLowerCase().includes(term))) {
      editor.setAgentSteps(steps.map((step) => ({ ...step, state: "failed" as const })));
      editor.addMessage("assistant", "Esse pedido depende de contexto visual. O agente atual trabalha apenas com transcript, metadata e timeline; nenhuma mídia foi enviada ao modelo.");
      return;
    }
    if (!isTauriRuntime()) {
      editor.setAgentSteps(steps.map((step, index) => ({ ...step, state: index === 0 ? "completed" as const : "cancelled" as const })));
      editor.addMessage("assistant", "A interface está em modo web. Execute o aplicativo Tauri e configure a chave Gemini para aplicar edições pelo agente.");
      return;
    }
    try {
      editor.setAgentSteps(steps.map((step, index) => ({ ...step, state: index === 1 ? "running" as const : index < 1 ? "completed" as const : step.state })));
      const plan = await nativeApi.planEdit(text, editor.project, editor.messages);
      if (cancelledRef.current) {
        editor.setAgentSteps(steps.map((step) => ({ ...step, state: "cancelled" as const })));
        editor.addMessage("assistant", "Operação cancelada antes de alterar a timeline.");
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
      <div className="chat-config">
        <span>Gemini usa somente texto</span>
        <button className="text-link" onClick={() => setShowKey(!showKey)}>Chave da sessão</button>
      </div>
      {showKey && <div className="key-entry"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="GEMINI_API_KEY" /><button className="text-button" onClick={() => void configureKey()}>Aplicar</button></div>}
      <div className="messages" aria-live="polite">
        {editor.messages.length === 0 && <div className="empty-chat"><Icon name="chat" /><strong>Descreva a edição</strong><p>O agente recebe transcript, seleção e estado da timeline. Áudio e vídeo permanecem locais.</p></div>}
        {editor.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "Você" : message.role === "assistant" ? "Gemini" : "Sistema"}</span><p>{message.text}</p></article>)}
        {editor.agentSteps.length > 0 && <div className="agent-ledger">{editor.agentSteps.map((step) => <div key={step.id} data-state={step.state}><span className="step-indicator" /><span>{step.label}</span><small>{step.state}</small></div>)}</div>}
        <div ref={messagesEnd} />
      </div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Descreva o resultado desejado" rows={3} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} />
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
        <LeftPanel />
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
