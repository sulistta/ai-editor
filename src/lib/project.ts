import type {
  CaptionCue,
  EditCommand,
  EditTransaction,
  EditorProject,
  MediaAsset,
  Sequence,
  TimelineClip,
  TimelineTrack,
  Transcript,
} from "../types";
import { PROJECT_SCHEMA_VERSION, TICKS_PER_SECOND } from "../types";
import { normalizeKeyframes, transformAtOffset } from "./transform";

export const EMPTY_TRANSFORM = {
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0,
  cropLeft: 0,
};

export const DEFAULT_CAPTION_STYLE = {
  fontFamily: "modern",
  fontSize: 48,
  textColor: "#FFFFFF",
  background: true,
  backgroundColor: "#000000",
  uppercase: false,
  bold: true,
  position: "bottom",
} as const;

export function createId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createEmptyProject(name = "Projeto sem título"): EditorProject {
  const sequenceId = createId("sequence");
  const tracks: TimelineTrack[] = [
    { id: createId("track-video"), name: "V1", kind: "video", locked: false, muted: false, hidden: false, clips: [] },
    { id: createId("track-audio"), name: "A1", kind: "audio", locked: false, muted: false, hidden: false, clips: [] },
  ];
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: createId("project"),
    name,
    revision: 0,
    settings: {
      width: 1920,
      height: 1080,
      fpsNum: 30,
      fpsDen: 1,
      sampleRate: 48_000,
      timebase: TICKS_PER_SECOND,
    },
    assets: [],
    sequences: [{ id: sequenceId, name: "Sequência 01", tracks, markers: [], captions: [], captionStyle: { ...DEFAULT_CAPTION_STYLE } }],
    activeSequenceId: sequenceId,
    transcripts: [],
  };
}

export function activeSequence(project: EditorProject): Sequence {
  return project.sequences.find((sequence) => sequence.id === project.activeSequenceId) ?? project.sequences[0]!;
}

export function sequenceDuration(sequence: Sequence): number {
  return sequence.tracks.reduce(
    (max, track) => track.clips.reduce((trackMax, clip) => Math.max(trackMax, clip.startTick + clip.durationTicks), max),
    0,
  );
}

export function makeClip(asset: MediaAsset, startTick: number): TimelineClip {
  return {
    id: createId("clip"),
    assetId: asset.id,
    name: asset.name,
    startTick,
    sourceInTick: 0,
    durationTicks: asset.durationTicks,
    speed: 1,
    volume: 1,
    transform: { ...EMPTY_TRANSFORM },
    keyframes: [],
    effects: [],
  };
}

export function captionsFromTranscript(project: EditorProject, transcript: Transcript): CaptionCue[] {
  const sequence = activeSequence(project);
  const placements = sequence.tracks.flatMap((track) => track.clips).filter((clip) => clip.assetId === transcript.assetId);
  if (placements.length === 0) {
    return transcript.segments.map((segment) => ({ id: createId("caption"), startTick: segment.startTick, endTick: segment.endTick, text: segment.text.trim() }));
  }
  const captions: CaptionCue[] = [];
  for (const clip of placements) {
    const sourceStart = clip.sourceInTick;
    const sourceEnd = sourceStart + Math.round(clip.durationTicks * clip.speed);
    for (const segment of transcript.segments) {
      const overlapStart = Math.max(segment.startTick, sourceStart);
      const overlapEnd = Math.min(segment.endTick, sourceEnd);
      if (overlapEnd <= overlapStart) continue;
      captions.push({
        id: createId("caption"),
        startTick: clip.startTick + Math.round((overlapStart - sourceStart) / clip.speed),
        endTick: clip.startTick + Math.round((overlapEnd - sourceStart) / clip.speed),
        text: segment.text.trim(),
      });
    }
  }
  return captions.sort((a, b) => a.startTick - b.startTick);
}

function normalizeClipTiming(clip: TimelineClip): void {
  clip.keyframes = normalizeKeyframes(clip.keyframes, clip.durationTicks);
  if (clip.transitionIn) clip.transitionIn.durationTicks = Math.max(1, Math.min(clip.durationTicks, clip.transitionIn.durationTicks));
  if (clip.transitionOut) clip.transitionOut.durationTicks = Math.max(1, Math.min(clip.durationTicks, clip.transitionOut.durationTicks));
}

function truncateClipAnimation(clip: TimelineClip, durationTicks: number, boundaryId: string): void {
  if (!clip.keyframes.some((keyframe) => keyframe.offsetTick > durationTicks)) return;
  const boundaryTransform = transformAtOffset(clip.transform, clip.keyframes, durationTicks);
  clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.offsetTick <= durationTicks);
  if (!clip.keyframes.some((keyframe) => keyframe.offsetTick === durationTicks)) {
    clip.keyframes.push({ id: boundaryId, offsetTick: durationTicks, easing: "linear", value: boundaryTransform });
  }
}

function applyCommand(project: EditorProject, command: EditCommand): void {
  if (command.type === "setProjectSettings") {
    project.settings = command.settings;
    return;
  }
  const sequence = activeSequence(project);
  if (command.type === "addAsset") {
    if (!project.assets.some((asset) => asset.id === command.asset.id)) project.assets.push(command.asset);
    return;
  }
  if (command.type === "updateAsset") {
    const index = project.assets.findIndex((asset) => asset.id === command.asset.id);
    if (index >= 0) project.assets[index] = command.asset;
    return;
  }
  if (command.type === "setTranscript") {
    project.transcripts = project.transcripts.filter((item) => item.assetId !== command.transcript.assetId);
    project.transcripts.push(command.transcript);
    return;
  }
  if (command.type === "setCaptions") {
    const target = project.sequences.find((item) => item.id === command.sequenceId);
    if (target) target.captions = command.captions;
    return;
  }
  if (command.type === "setCaptionStyle") {
    const target = project.sequences.find((item) => item.id === command.sequenceId);
    if (target) target.captionStyle = command.style;
    return;
  }
  if (command.type === "addTrack") {
    const target = project.sequences.find((item) => item.id === command.sequenceId);
    if (target) target.tracks.push(command.track);
    return;
  }
  if (command.type === "updateTrack") {
    const target = project.sequences.find((item) => item.id === command.sequenceId)?.tracks.find((item) => item.id === command.trackId);
    if (target) Object.assign(target, command.patch);
    return;
  }
  const track = sequence.tracks.find((item) => item.id === command.trackId);
  if (!track || track.locked) return;
  if (command.type === "insertClip") {
    track.clips.push(command.clip);
    track.clips.sort((a, b) => a.startTick - b.startTick);
    return;
  }
  const clipIndex = track.clips.findIndex((item) => item.id === command.clipId);
  const clip = track.clips[clipIndex];
  if (!clip) return;
  switch (command.type) {
    case "moveClip":
      clip.startTick = Math.max(0, command.startTick);
      track.clips.sort((a, b) => a.startTick - b.startTick);
      break;
    case "trimClip":
      {
        const nextSourceIn = Math.max(0, command.sourceInTick);
        const shiftedTicks = Math.round((nextSourceIn - clip.sourceInTick) / clip.speed);
        if (shiftedTicks > 0) {
          clip.transform = transformAtOffset(clip.transform, clip.keyframes, shiftedTicks);
          clip.keyframes = clip.keyframes.filter((keyframe) => keyframe.offsetTick > shiftedTicks).map((keyframe) => ({ ...keyframe, offsetTick: keyframe.offsetTick - shiftedTicks }));
        } else if (shiftedTicks < 0) {
          clip.keyframes = clip.keyframes.map((keyframe) => ({ ...keyframe, offsetTick: keyframe.offsetTick - shiftedTicks }));
        }
        clip.sourceInTick = nextSourceIn;
      }
      {
        const nextDuration = Math.max(1, command.durationTicks);
        truncateClipAnimation(clip, nextDuration, `${clip.id}-trim-boundary`);
        clip.durationTicks = nextDuration;
      }
      normalizeClipTiming(clip);
      break;
    case "splitClip": {
      const leftDuration = command.atTick - clip.startTick;
      if (leftDuration <= 0 || leftDuration >= clip.durationTicks) break;
      const splitTransform = transformAtOffset(clip.transform, clip.keyframes, leftDuration);
      const right: TimelineClip = {
        ...structuredClone(clip),
        id: command.rightClipId,
        startTick: command.atTick,
        sourceInTick: clip.sourceInTick + Math.round(leftDuration * clip.speed),
        durationTicks: clip.durationTicks - leftDuration,
        transform: splitTransform,
        keyframes: clip.keyframes.filter((keyframe) => keyframe.offsetTick > leftDuration).map((keyframe) => ({ ...keyframe, offsetTick: keyframe.offsetTick - leftDuration })),
        transitionIn: undefined,
      };
      truncateClipAnimation(clip, leftDuration, `${command.rightClipId}-split-boundary`);
      clip.transitionOut = undefined;
      clip.durationTicks = leftDuration;
      normalizeClipTiming(clip);
      normalizeClipTiming(right);
      track.clips.splice(clipIndex + 1, 0, right);
      break;
    }
    case "deleteClip": {
      track.clips.splice(clipIndex, 1);
      if (command.ripple) {
        const removedEnd = clip.startTick + clip.durationTicks;
        for (const candidate of track.clips) {
          if (candidate.startTick >= removedEnd) candidate.startTick -= clip.durationTicks;
        }
      }
      break;
    }
    case "updateClip":
      {
        const patch = structuredClone(command.patch);
        if (typeof patch.durationTicks === "number" && patch.keyframes === undefined) {
          truncateClipAnimation(clip, Math.max(1, patch.durationTicks), `${clip.id}-duration-boundary`);
        }
        if (typeof patch.speed === "number" && typeof patch.durationTicks !== "number") {
          const nextSpeed = Math.min(20, Math.max(0.05, patch.speed));
          const nextDuration = Math.max(1, Math.round(clip.durationTicks * clip.speed / nextSpeed));
          clip.keyframes = clip.keyframes.map((keyframe) => ({ ...keyframe, offsetTick: Math.round(keyframe.offsetTick * nextDuration / clip.durationTicks) }));
          patch.speed = nextSpeed;
          patch.durationTicks = nextDuration;
        }
        Object.assign(clip, patch);
        normalizeClipTiming(clip);
      }
      break;
  }
}

export function applyTransaction(project: EditorProject, transaction: EditTransaction): EditorProject {
  if (transaction.baseRevision !== project.revision) {
    throw new Error(`Revisão desatualizada: esperado ${project.revision}, recebido ${transaction.baseRevision}`);
  }
  const next = structuredClone(project);
  for (const command of transaction.commands) applyCommand(next, command);
  next.revision += 1;
  return next;
}
