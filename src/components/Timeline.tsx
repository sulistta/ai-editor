import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../context/EditorContext";
import { activeSequence, createId, makeClip, sequenceDuration } from "../lib/project";
import { formatTimecode, frameDurationTicks, snapTickToFrame, ticksToSeconds } from "../lib/time";
import type { TimelineClip, TimelineTrack } from "../types";
import { Icon } from "./Icons";

const GUTTER = 82;
const RULER = 28;
const TRACK_HEIGHT = 54;

interface DragOperation {
  mode: "move" | "trimStart" | "trimEnd";
  clip: TimelineClip;
  track: TimelineTrack;
  offsetTick: number;
  previewTick: number;
  previewDuration: number;
  previewSourceIn: number;
}

function clipColor(track: TimelineTrack): string {
  if (track.kind === "audio") return "#293028";
  if (track.kind === "caption") return "#302d1f";
  return "#252821";
}

export function Timeline() {
  const editor = useEditor();
  const sequence = activeSequence(editor.project);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragOperation | null>(null);
  const [viewport, setViewport] = useState({ width: 900, scrollLeft: 0 });
  const pixelsPerSecond = 72 * editor.zoom;
  const duration = Math.max(sequenceDuration(sequence), 60 * editor.project.settings.timebase);
  const virtualWidth = GUTTER + ticksToSeconds(duration) * pixelsPerSecond + 400;
  const height = RULER + sequence.tracks.length * TRACK_HEIGHT;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport((value) => ({ ...value, width: element.clientWidth })));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = viewport.width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = "#0b0c0a";
    context.fillRect(0, 0, viewport.width, height);
    context.font = "10px 'IBM Plex Mono', monospace";
    context.textBaseline = "middle";

    context.fillStyle = "#11120f";
    context.fillRect(0, 0, GUTTER, height);
    context.strokeStyle = "#30322c";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(GUTTER - 0.5, 0);
    context.lineTo(GUTTER - 0.5, height);
    context.stroke();

    const startSecond = Math.floor(viewport.scrollLeft / pixelsPerSecond);
    const endSecond = Math.ceil((viewport.scrollLeft + viewport.width) / pixelsPerSecond);
    for (let second = startSecond; second <= endSecond; second += 1) {
      const x = GUTTER + second * pixelsPerSecond - viewport.scrollLeft;
      const major = second % 5 === 0;
      context.strokeStyle = major ? "#34362f" : "#22241f";
      context.beginPath();
      context.moveTo(x + 0.5, major ? 5 : 16);
      context.lineTo(x + 0.5, height);
      context.stroke();
      if (major) {
        context.fillStyle = "#81857a";
        context.fillText(formatTimecode(second * editor.project.settings.timebase, editor.project.settings.fpsNum, editor.project.settings.fpsDen).slice(3, -3), x + 4, 11);
      }
    }

    sequence.tracks.forEach((track, trackIndex) => {
      const y = RULER + trackIndex * TRACK_HEIGHT;
      context.fillStyle = trackIndex % 2 ? "#0e0f0d" : "#10110e";
      context.fillRect(GUTTER, y, viewport.width - GUTTER, TRACK_HEIGHT);
      context.strokeStyle = "#292b26";
      context.beginPath();
      context.moveTo(0, y + TRACK_HEIGHT - 0.5);
      context.lineTo(viewport.width, y + TRACK_HEIGHT - 0.5);
      context.stroke();
      context.fillStyle = track.locked ? "#5f625a" : "#d7d9d2";
      context.fillText(track.name, 7, y + 16);
      context.fillStyle = "#72766d";
      context.font = "8px 'IBM Plex Mono', monospace";
      context.fillText(track.kind.toUpperCase().slice(0, 3), 7, y + 37);
      context.fillStyle = track.locked ? "#ffb800" : "#555950";
      context.fillText("L", 49, y + 37);
      context.fillStyle = (track.kind === "video" ? track.hidden : track.muted) ? "#ffb800" : "#555950";
      context.fillText(track.kind === "video" ? "V" : "M", 67, y + 37);
      context.font = "10px 'IBM Plex Mono', monospace";

      for (const clip of track.clips) {
        const drag = dragRef.current?.clip.id === clip.id ? dragRef.current : null;
        const start = drag?.previewTick ?? clip.startTick;
        const x = GUTTER + ticksToSeconds(start) * pixelsPerSecond - viewport.scrollLeft;
        const duration = drag?.previewDuration ?? clip.durationTicks;
        const width = Math.max(4, ticksToSeconds(duration) * pixelsPerSecond);
        if (x + width < GUTTER || x > viewport.width) continue;
        const selected = editor.selection.clipIds.includes(clip.id);
        context.fillStyle = selected ? "#403b20" : clipColor(track);
        context.fillRect(x, y + 5, width, TRACK_HEIGHT - 10);
        context.strokeStyle = selected ? "#ffb800" : "#4a4d44";
        context.strokeRect(x + 0.5, y + 5.5, width - 1, TRACK_HEIGHT - 11);
        const clipAsset = editor.project.assets.find((asset) => asset.id === clip.assetId);
        const waveform = clipAsset?.waveform;
        const assetDuration = clipAsset?.durationTicks ?? 0;
        if (track.kind === "audio" && waveform?.length && assetDuration > 0 && width > 8) {
          context.strokeStyle = selected ? "#c6a94c" : "#60675b";
          context.lineWidth = 1;
          context.beginPath();
          const center = y + TRACK_HEIGHT / 2;
          const firstPixel = Math.max(0, GUTTER - x);
          const lastPixel = Math.min(width, viewport.width - x);
          for (let pixel = firstPixel; pixel < lastPixel; pixel += 2) {
            const localTick = (pixel / width) * duration;
            const sourceTick = clip.sourceInTick + localTick * clip.speed;
            const sample = waveform[Math.min(waveform.length - 1, Math.max(0, Math.floor(sourceTick / assetDuration * waveform.length)))] ?? 0;
            const amplitude = sample * (TRACK_HEIGHT - 18) / 2;
            context.moveTo(x + pixel + 0.5, center - amplitude);
            context.lineTo(x + pixel + 0.5, center + amplitude);
          }
          context.stroke();
        }
        context.save();
        context.beginPath();
        context.rect(x + 6, y + 6, Math.max(0, width - 12), TRACK_HEIGHT - 12);
        context.clip();
        context.fillStyle = selected ? "#ffdc71" : "#d1d4cc";
        context.fillText(clip.name, x + 7, y + 17);
        context.fillStyle = selected ? "#c8ad53" : "#777b72";
        context.fillText(formatTimecode(duration, editor.project.settings.fpsNum, editor.project.settings.fpsDen), x + 7, y + 35);
        context.restore();
        if (clip.transitionIn) {
          context.fillStyle = "#ffb800";
          context.beginPath();
          context.moveTo(x + 1, y + 6);
          context.lineTo(x + Math.min(width / 2, ticksToSeconds(clip.transitionIn.durationTicks) * pixelsPerSecond), y + 6);
          context.lineTo(x + 1, y + 18);
          context.fill();
        }
        if (clip.transitionOut) {
          context.fillStyle = "#ffb800";
          context.beginPath();
          context.moveTo(x + width - 1, y + 6);
          context.lineTo(x + width - Math.min(width / 2, ticksToSeconds(clip.transitionOut.durationTicks) * pixelsPerSecond), y + 6);
          context.lineTo(x + width - 1, y + 18);
          context.fill();
        }
      }
    });

    const playheadX = GUTTER + ticksToSeconds(editor.playheadTick) * pixelsPerSecond - viewport.scrollLeft;
    if (playheadX >= GUTTER && playheadX <= viewport.width) {
      context.strokeStyle = "#ffb800";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(playheadX + 0.5, 0);
      context.lineTo(playheadX + 0.5, height);
      context.stroke();
      context.fillStyle = "#ffb800";
      context.fillRect(playheadX - 3, 0, 7, 5);
    }

    const activeStep = editor.agentSteps.find((step) => step.state === "running" && step.range);
    if (activeStep?.range) {
      const from = GUTTER + ticksToSeconds(activeStep.range.startTick) * pixelsPerSecond - viewport.scrollLeft;
      const to = GUTTER + ticksToSeconds(activeStep.range.endTick) * pixelsPerSecond - viewport.scrollLeft;
      context.fillStyle = "rgba(255,184,0,.11)";
      context.fillRect(from, RULER, Math.max(2, to - from), height - RULER);
      context.strokeStyle = "#ffb800";
      context.setLineDash([4, 4]);
      context.strokeRect(from + 0.5, RULER + 0.5, Math.max(1, to - from - 1), height - RULER - 1);
      context.setLineDash([]);
    }
  }, [editor.agentSteps, editor.playheadTick, editor.project.assets, editor.project.settings, editor.selection.clipIds, height, pixelsPerSecond, sequence.tracks, viewport]);

  useEffect(() => draw(), [draw]);

  const locate = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const tick = Math.max(0, ((x - GUTTER + viewport.scrollLeft) / pixelsPerSecond) * editor.project.settings.timebase);
    const trackIndex = Math.floor((y - RULER) / TRACK_HEIGHT);
    return { tick, track: sequence.tracks[trackIndex], x, y };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const { tick, track, x } = locate(event.clientX, event.clientY);
    if (!track) return;
    if (x < GUTTER) {
      if (x >= 40 && x < 60) void editor.commit("Alternar bloqueio da faixa", [{ type: "updateTrack", sequenceId: sequence.id, trackId: track.id, patch: { locked: !track.locked } }]);
      if (x >= 60) void editor.commit(track.kind === "video" ? "Alternar visibilidade da faixa" : "Alternar mute da faixa", [{ type: "updateTrack", sequenceId: sequence.id, trackId: track.id, patch: track.kind === "video" ? { hidden: !track.hidden } : { muted: !track.muted } }]);
      return;
    }
    const clip = [...track.clips].reverse().find((item) => tick >= item.startTick && tick <= item.startTick + item.durationTicks);
    if (clip) {
      const clipIds = event.shiftKey && editor.selection.trackId === track.id
        ? editor.selection.clipIds.includes(clip.id) ? editor.selection.clipIds.filter((id) => id !== clip.id) : [...editor.selection.clipIds, clip.id]
        : [clip.id];
      editor.select({ clipIds, trackId: track.id, assetId: clip.assetId });
      if (clipIds.length === 0) return;
      if (track.locked) return;
      const clipX = GUTTER + ticksToSeconds(clip.startTick) * pixelsPerSecond - viewport.scrollLeft;
      const clipWidth = ticksToSeconds(clip.durationTicks) * pixelsPerSecond;
      const edgeDistance = 7;
      const mode: DragOperation["mode"] = Math.abs(x - clipX) <= edgeDistance ? "trimStart" : Math.abs(x - clipX - clipWidth) <= edgeDistance ? "trimEnd" : "move";
      dragRef.current = { mode, clip, track, offsetTick: tick - clip.startTick, previewTick: clip.startTick, previewDuration: clip.durationTicks, previewSourceIn: clip.sourceInTick };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      editor.select({ clipIds: [], trackId: track.id });
      editor.setPlayhead(tick);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const frame = frameDurationTicks(editor.project.settings.fpsNum, editor.project.settings.fpsDen);
    const located = snapTickToFrame(locate(event.clientX, event.clientY).tick, editor.project.settings.fpsNum, editor.project.settings.fpsDen);
    if (drag.mode === "move") {
      drag.previewTick = snapTickToFrame(Math.max(0, located - drag.offsetTick), editor.project.settings.fpsNum, editor.project.settings.fpsDen);
    } else if (drag.mode === "trimStart") {
      const end = drag.clip.startTick + drag.clip.durationTicks;
      const earliest = Math.max(0, drag.clip.startTick - Math.round(drag.clip.sourceInTick / drag.clip.speed));
      drag.previewTick = Math.max(earliest, Math.min(end - frame, located));
      const removed = drag.previewTick - drag.clip.startTick;
      drag.previewDuration = drag.clip.durationTicks - removed;
      drag.previewSourceIn = Math.max(0, drag.clip.sourceInTick + Math.round(removed * drag.clip.speed));
    } else {
      drag.previewDuration = Math.max(frame, located - drag.clip.startTick);
    }
    draw();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.mode === "move") {
      void editor.commit("Mover clipe", [{ type: "moveClip", trackId: drag.track.id, clipId: drag.clip.id, startTick: Math.round(drag.previewTick) }]);
    } else if (drag.mode === "trimStart") {
      void editor.commit("Aparar entrada", [
        { type: "moveClip", trackId: drag.track.id, clipId: drag.clip.id, startTick: Math.round(drag.previewTick) },
        { type: "trimClip", trackId: drag.track.id, clipId: drag.clip.id, sourceInTick: Math.round(drag.previewSourceIn), durationTicks: Math.round(drag.previewDuration) },
      ]);
    } else {
      void editor.commit("Aparar saída", [{ type: "trimClip", trackId: drag.track.id, clipId: drag.clip.id, sourceInTick: drag.clip.sourceInTick, durationTicks: Math.round(drag.previewDuration) }]);
    }
  };

  const onDrop = (event: React.DragEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData("application/x-ai-editor-asset");
    const asset = editor.project.assets.find((item) => item.id === assetId);
    if (!asset || asset.offline) return;
    const located = locate(event.clientX, event.clientY);
    const expectedKind = asset.width && asset.height ? "video" : "audio";
    const track = located.track?.kind === expectedKind && !located.track.locked ? located.track : sequence.tracks.find((item) => item.kind === expectedKind && !item.locked);
    if (!track) return;
    const startTick = snapTickToFrame(located.tick, editor.project.settings.fpsNum, editor.project.settings.fpsDen);
    const clip = makeClip(asset, startTick);
    void editor.commit(`Inserir ${asset.name}`, [{ type: "insertClip", trackId: track.id, clip }]).then(() => editor.select({ clipIds: [clip.id], trackId: track.id, assetId }));
  };

  const accessibleClips = useMemo(() => sequence.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))), [sequence.tracks]);
  const addTrack = (kind: "video" | "audio") => {
    const count = sequence.tracks.filter((track) => track.kind === kind).length + 1;
    void editor.commit("Adicionar faixa", [{
      type: "addTrack",
      sequenceId: sequence.id,
      track: { id: createId(`track-${kind}`), name: `${kind === "video" ? "V" : "A"}${count}`, kind, locked: false, muted: false, hidden: false, clips: [] },
    }]);
  };

  return (
    <section className="timeline-shell" aria-label="Timeline">
      <div className="timeline-toolbar">
        <div className="tool-group">
          <button className="icon-button" onClick={() => void editor.splitSelected()} title="Dividir no playhead" aria-label="Dividir no playhead"><Icon name="split" /></button>
          <button className="icon-button" onClick={() => void editor.deleteSelected(false)} title="Excluir selecionado" aria-label="Excluir selecionado"><Icon name="trash" /></button>
          <button className="text-button" onClick={() => void editor.duplicateSelected()}>Duplicar</button>
          <button className="text-button" onClick={() => void editor.deleteSelected(true)}>Ripple delete</button>
        </div>
        <span className="timecode">{formatTimecode(editor.playheadTick, editor.project.settings.fpsNum, editor.project.settings.fpsDen)}</span>
        <label className="zoom-control">Zoom <input type="range" min="0.25" max="4" step="0.25" value={editor.zoom} onChange={(event) => editor.setZoom(Number(event.target.value))} /></label>
      </div>
      <div
        className="timeline-scroll"
        ref={containerRef}
        onScroll={(event) => setViewport((value) => ({ ...value, scrollLeft: event.currentTarget.scrollLeft }))}
      >
        <div className="timeline-virtual-width" style={{ width: virtualWidth, height }}>
          <canvas
            ref={canvasRef}
            className="timeline-canvas"
            style={{ left: viewport.scrollLeft }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
            onDrop={onDrop}
            aria-label="Faixas e clipes da sequência"
          />
        </div>
      </div>
      <ul className="sr-only">
        {accessibleClips.map(({ track, clip }) => <li key={clip.id}>{clip.name}, faixa {track.name}, início {formatTimecode(clip.startTick)}</li>)}
      </ul>
      <div className="timeline-add-track"><button onClick={() => addTrack("video")}><Icon name="plus" /> Vídeo</button><button onClick={() => addTrack("audio")}><Icon name="plus" /> Áudio</button></div>
    </section>
  );
}
