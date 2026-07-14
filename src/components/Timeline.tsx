import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../context/EditorContext";
import { scheduleAppSurfaceRefresh } from "../lib/compositor";
import { activeSequence, createId, makeClip, sequenceDuration } from "../lib/project";
import { formatTimecode, frameDurationTicks, snapTickToFrame, ticksToSeconds } from "../lib/time";
import type { TimelineClip, TimelineTrack } from "../types";
import { Icon } from "./Icons";

const GUTTER = 100;
const RULER = 28;
const TRACK_HEIGHT = 54;
const SCROLLBAR_SIZE = 12;

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
  const scrubPointerRef = useRef<number | null>(null);
  const pendingScrollRef = useRef({ scrollLeft: 0, scrollTop: 0 });
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const [viewport, setViewport] = useState({ width: 900, height: 180, scrollLeft: 0, scrollTop: 0 });
  const pixelsPerSecond = 72 * editor.zoom;
  const duration = Math.max(sequenceDuration(sequence), 60 * editor.project.settings.timebase);
  const virtualWidth = GUTTER + ticksToSeconds(duration) * pixelsPerSecond + 400;
  const height = RULER + sequence.tracks.length * TRACK_HEIGHT;
  const canvasHeight = Math.max(1, viewport.height - SCROLLBAR_SIZE);
  const maxScrollTop = Math.max(0, height - canvasHeight);
  const canvasWidth = Math.max(1, viewport.width - (maxScrollTop > 0 ? SCROLLBAR_SIZE : 0));
  const maxScrollLeft = Math.max(0, virtualWidth - canvasWidth);
  const scrollLeft = Math.min(viewport.scrollLeft, maxScrollLeft);
  const scrollTop = Math.min(viewport.scrollTop, maxScrollTop);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => setViewport((value) => ({
      ...value,
      width: element.clientWidth,
      height: element.clientHeight,
    }));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [setViewport]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const updateScrollViewport = useCallback((scrollLeft: number, scrollTop: number) => {
    pendingScrollRef.current = {
      scrollLeft: Math.max(0, Math.min(maxScrollLeft, scrollLeft)),
      scrollTop: Math.max(0, Math.min(maxScrollTop, scrollTop)),
    };
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      setViewport((value) => {
        const pending = pendingScrollRef.current;
        if (value.scrollLeft === pending.scrollLeft && value.scrollTop === pending.scrollTop) return value;
        return { ...value, ...pending };
      });
    });
  }, [maxScrollLeft, maxScrollTop, setViewport]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(canvasWidth * ratio));
    const pixelHeight = Math.max(1, Math.round(canvasHeight * ratio));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const cssWidth = `${canvasWidth}px`;
    const cssHeight = `${canvasHeight}px`;
    if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
    if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = "#0b0c0a";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    context.font = "10px 'IBM Plex Mono', monospace";
    context.textBaseline = "middle";

    context.fillStyle = "#11120f";
    context.fillRect(0, 0, GUTTER, canvasHeight);
    context.strokeStyle = "#30322c";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(GUTTER - 0.5, 0);
    context.lineTo(GUTTER - 0.5, canvasHeight);
    context.stroke();

    const startSecond = Math.floor(scrollLeft / pixelsPerSecond);
    const endSecond = Math.ceil((scrollLeft + canvasWidth) / pixelsPerSecond);
    for (let second = startSecond; second <= endSecond; second += 1) {
      const x = GUTTER + second * pixelsPerSecond - scrollLeft;
      const major = second % 5 === 0;
      context.strokeStyle = major ? "#34362f" : "#22241f";
      context.beginPath();
      context.moveTo(x + 0.5, major ? 5 : 16);
      context.lineTo(x + 0.5, canvasHeight);
      context.stroke();
      if (major) {
        context.fillStyle = "#81857a";
        context.fillText(formatTimecode(second * editor.project.settings.timebase, editor.project.settings.fpsNum, editor.project.settings.fpsDen).slice(3, -3), x + 4, 11);
      }
    }

    sequence.tracks.forEach((track, trackIndex) => {
      const y = RULER + trackIndex * TRACK_HEIGHT - scrollTop;
      if (y + TRACK_HEIGHT <= RULER || y >= canvasHeight) return;
      context.save();
      context.beginPath();
      context.rect(0, RULER, canvasWidth, Math.max(0, canvasHeight - RULER));
      context.clip();
      context.fillStyle = trackIndex % 2 ? "#0e0f0d" : "#10110e";
      context.fillRect(GUTTER, y, canvasWidth - GUTTER, TRACK_HEIGHT);
      context.strokeStyle = "#292b26";
      context.beginPath();
      context.moveTo(0, y + TRACK_HEIGHT - 0.5);
      context.lineTo(canvasWidth, y + TRACK_HEIGHT - 0.5);
      context.stroke();
      context.fillStyle = track.locked ? "#5f625a" : "#d7d9d2";
      context.fillText(track.name, 7, y + 16);
      context.fillStyle = "#72766d";
      context.font = "8px 'IBM Plex Mono', monospace";
      context.fillText(track.kind.toUpperCase().slice(0, 3), 7, y + 37);
      context.fillStyle = track.locked ? "#ffb800" : "#555950";
      context.fillText("L", 52, y + 37);
      if (track.kind === "video") {
        context.fillStyle = track.hidden ? "#ffb800" : "#555950";
        context.fillText("V", 70, y + 37);
      }
      if (track.kind !== "caption") {
        context.fillStyle = track.muted ? "#ffb800" : "#555950";
        context.fillText("M", 88, y + 37);
      }
      context.font = "10px 'IBM Plex Mono', monospace";

      for (const clip of track.clips) {
        const drag = dragRef.current?.clip.id === clip.id ? dragRef.current : null;
        const start = drag?.previewTick ?? clip.startTick;
        const x = GUTTER + ticksToSeconds(start) * pixelsPerSecond - scrollLeft;
        const duration = drag?.previewDuration ?? clip.durationTicks;
        const width = Math.max(4, ticksToSeconds(duration) * pixelsPerSecond);
        if (x + width < GUTTER || x > canvasWidth) continue;
        context.save();
        context.globalAlpha = track.hidden || (track.kind === "audio" && track.muted) ? 0.42 : 1;
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
          const lastPixel = Math.min(width, canvasWidth - x);
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
        context.restore();
      }
      context.restore();
    });

    const playheadX = GUTTER + ticksToSeconds(editor.playheadTick) * pixelsPerSecond - scrollLeft;
    if (playheadX >= GUTTER && playheadX <= canvasWidth) {
      context.strokeStyle = "#ffb800";
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(playheadX + 0.5, 0);
      context.lineTo(playheadX + 0.5, canvasHeight);
      context.stroke();
      context.fillStyle = "#ffb800";
      context.fillRect(playheadX - 3, 0, 7, 5);
    }

    const activeStep = editor.agentSteps.find((step) => step.state === "running" && step.range);
    if (activeStep?.range) {
      const from = GUTTER + ticksToSeconds(activeStep.range.startTick) * pixelsPerSecond - scrollLeft;
      const to = GUTTER + ticksToSeconds(activeStep.range.endTick) * pixelsPerSecond - scrollLeft;
      context.fillStyle = "rgba(255,184,0,.11)";
      context.fillRect(from, RULER, Math.max(2, to - from), canvasHeight - RULER);
      context.strokeStyle = "#ffb800";
      context.setLineDash([4, 4]);
      context.strokeRect(from + 0.5, RULER + 0.5, Math.max(1, to - from - 1), canvasHeight - RULER - 1);
      context.setLineDash([]);
    }
  }, [canvasHeight, canvasWidth, editor.agentSteps, editor.playheadTick, editor.project.assets, editor.project.settings, editor.selection.clipIds, pixelsPerSecond, scrollLeft, scrollTop, sequence.tracks]);

  useEffect(() => draw(), [draw]);

  useEffect(() => {
    scheduleAppSurfaceRefresh();
  }, [scrollLeft, scrollTop]);

  useEffect(() => {
    if (!editor.isPlaying) return;
    const playheadContentX = GUTTER + ticksToSeconds(editor.playheadTick) * pixelsPerSecond;
    const visibleStart = scrollLeft + GUTTER;
    const visibleEnd = scrollLeft + canvasWidth - 24;
    if (playheadContentX >= visibleStart && playheadContentX <= visibleEnd) return;
    const timelineWidth = Math.max(1, canvasWidth - GUTTER);
    updateScrollViewport(playheadContentX - GUTTER - timelineWidth * 0.25, scrollTop);
  }, [canvasWidth, editor.isPlaying, editor.playheadTick, pixelsPerSecond, scrollLeft, scrollTop, updateScrollViewport]);

  const locate = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const tick = Math.max(0, ((x - GUTTER + scrollLeft) / pixelsPerSecond) * editor.project.settings.timebase);
    const trackIndex = Math.floor((y - RULER + scrollTop) / TRACK_HEIGHT);
    return { tick, track: sequence.tracks[trackIndex], x, y };
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || maxScrollTop === 0) {
      updateScrollViewport(scrollLeft + (event.deltaX || event.deltaY), scrollTop);
    } else {
      updateScrollViewport(scrollLeft + event.deltaX, scrollTop + event.deltaY);
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { tick, track, x, y } = locate(event.clientX, event.clientY);
    if (x >= GUTTER && y < RULER) {
      editor.setPlaying(false);
      editor.setPlayhead(snapTickToFrame(tick, editor.project.settings.fpsNum, editor.project.settings.fpsDen));
      scrubPointerRef.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (!track) return;
    if (x < GUTTER) {
      if (x >= 44 && x < 64) void editor.commit("Alternar bloqueio da faixa", [{ type: "updateTrack", sequenceId: sequence.id, trackId: track.id, patch: { locked: !track.locked } }]);
      else if (track.kind === "video" && x >= 64 && x < 82) void editor.commit("Alternar visibilidade da faixa", [{ type: "updateTrack", sequenceId: sequence.id, trackId: track.id, patch: { hidden: !track.hidden } }]);
      else if (track.kind !== "caption" && x >= 82) void editor.commit("Alternar mute da faixa", [{ type: "updateTrack", sequenceId: sequence.id, trackId: track.id, patch: { muted: !track.muted } }]);
      return;
    }
    const clip = [...track.clips].reverse().find((item) => tick >= item.startTick && tick < item.startTick + item.durationTicks);
    if (clip) {
      const clipIds = event.shiftKey && editor.selection.trackId === track.id
        ? editor.selection.clipIds.includes(clip.id) ? editor.selection.clipIds.filter((id) => id !== clip.id) : [...editor.selection.clipIds, clip.id]
        : [clip.id];
      editor.select({ clipIds, trackId: track.id, assetId: clip.assetId });
      if (clipIds.length === 0) return;
      if (track.locked) return;
      const clipX = GUTTER + ticksToSeconds(clip.startTick) * pixelsPerSecond - scrollLeft;
      const clipWidth = ticksToSeconds(clip.durationTicks) * pixelsPerSecond;
      const edgeDistance = 7;
      const mode: DragOperation["mode"] = Math.abs(x - clipX) <= edgeDistance ? "trimStart" : Math.abs(x - clipX - clipWidth) <= edgeDistance ? "trimEnd" : "move";
      dragRef.current = { mode, clip, track, offsetTick: tick - clip.startTick, previewTick: clip.startTick, previewDuration: clip.durationTicks, previewSourceIn: clip.sourceInTick };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      editor.select({ clipIds: [], trackId: track.id });
      editor.setPlaying(false);
      editor.setPlayhead(snapTickToFrame(tick, editor.project.settings.fpsNum, editor.project.settings.fpsDen));
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (scrubPointerRef.current === event.pointerId) {
      const tick = locate(event.clientX, event.clientY).tick;
      editor.setPlayhead(snapTickToFrame(tick, editor.project.settings.fpsNum, editor.project.settings.fpsDen));
      return;
    }
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
      const asset = editor.project.assets.find((item) => item.id === drag.clip.assetId);
      const availableDuration = asset ? Math.max(frame, Math.floor((asset.durationTicks - drag.clip.sourceInTick) / drag.clip.speed)) : Number.POSITIVE_INFINITY;
      drag.previewDuration = Math.min(availableDuration, Math.max(frame, located - drag.clip.startTick));
    }
    draw();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (scrubPointerRef.current === event.pointerId) {
      scrubPointerRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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

  const onPointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (scrubPointerRef.current === event.pointerId) scrubPointerRef.current = null;
    if (dragRef.current) {
      dragRef.current = null;
      draw();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
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
      <div className="timeline-viewport" ref={containerRef}>
        <canvas
          ref={canvasRef}
          className="timeline-canvas"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
          onDrop={onDrop}
          aria-label="Faixas e clipes da sequência"
        />
        <input
          className="timeline-scrollbar timeline-scrollbar-horizontal"
          type="range"
          min={0}
          max={maxScrollLeft}
          step={1}
          value={scrollLeft}
          onChange={(event) => updateScrollViewport(Number(event.target.value), scrollTop)}
          aria-label="Rolagem horizontal da timeline"
        />
        {maxScrollTop > 0 && (
          <input
            className="timeline-scrollbar timeline-scrollbar-vertical"
            type="range"
            min={0}
            max={maxScrollTop}
            step={1}
            value={scrollTop}
            onChange={(event) => updateScrollViewport(scrollLeft, Number(event.target.value))}
            aria-label="Rolagem vertical das faixas"
          />
        )}
      </div>
      <ul className="sr-only">
        {accessibleClips.map(({ track, clip }) => <li key={clip.id}>{clip.name}, faixa {track.name}, início {formatTimecode(clip.startTick)}</li>)}
      </ul>
      <div className="timeline-add-track"><button onClick={() => addTrack("video")}><Icon name="plus" /> Vídeo</button><button onClick={() => addTrack("audio")}><Icon name="plus" /> Áudio</button></div>
    </section>
  );
}
