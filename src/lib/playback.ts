import type { MediaAsset, Sequence, TimelineClip, TimelineTrack } from "../types";
import { ticksToSeconds } from "./time";

export interface PlaybackItem {
  clip: TimelineClip;
  track: TimelineTrack;
  trackIndex: number;
}

export function playbackItems(sequence: Sequence): PlaybackItem[] {
  return sequence.tracks
    .flatMap((track, trackIndex) => track.hidden || track.kind === "caption"
      ? []
      : track.clips.map((clip) => ({ clip, track, trackIndex })))
    .sort((left, right) => left.clip.startTick - right.clip.startTick || left.trackIndex - right.trackIndex);
}

export function activePlaybackItem(items: PlaybackItem[], tick: number): PlaybackItem | undefined {
  const active = items.filter(({ clip }) => tick >= clip.startTick && tick < clip.startTick + clip.durationTicks);
  const video = active.filter(({ track }) => track.kind === "video").sort((left, right) => right.trackIndex - left.trackIndex)[0];
  return video ?? active.find(({ track }) => track.kind === "audio" && !track.muted) ?? active[0];
}

export function playbackItemAtOrAfter(items: PlaybackItem[], tick: number): PlaybackItem | undefined {
  return activePlaybackItem(items, tick) ?? items.find(({ clip }) => clip.startTick >= tick);
}

export function resolvePlaybackAsset(assets: MediaAsset[], ...candidateIds: Array<string | undefined>): MediaAsset | undefined {
  for (const id of candidateIds) {
    if (!id) continue;
    const asset = assets.find((item) => item.id === id);
    if (asset) return asset;
  }
  return undefined;
}

export function timelineTickToMediaSeconds(clip: TimelineClip, timelineTick: number): number {
  const elapsed = Math.max(0, timelineTick - clip.startTick);
  return ticksToSeconds(clip.sourceInTick + Math.round(elapsed * clip.speed));
}

export function mediaVolume(clip: TimelineClip, track: TimelineTrack): { muted: boolean; volume: number } {
  return {
    muted: track.muted,
    volume: Math.min(1, Math.max(0, clip.volume)),
  };
}

export function needsCompatibilityProxy(asset: Pick<MediaAsset, "codec" | "width" | "height">): boolean {
  if (!asset.width || !asset.height) return false;
  const codec = asset.codec?.trim().toLowerCase();
  return codec === "av1" || codec === "vp9" || codec === "vp8" || codec === "hevc" || codec === "h265";
}

export function isCurrentCompatibilityProxy(path: string | undefined): boolean {
  return path?.toLowerCase().endsWith(".proxy-v3.mp4") ?? false;
}

export function playbackFailureMessage(assetName: string, error?: unknown, mediaErrorCode?: number): string {
  const errorName = error instanceof DOMException ? error.name : "";
  if (errorName === "NotAllowedError") return "A reprodução foi bloqueada pelo sistema. Clique novamente em Reproduzir.";
  if (errorName === "NotSupportedError" || mediaErrorCode === 4) return `O formato de “${assetName}” não é compatível com o monitor. Gere um proxy 720p e tente novamente.`;
  if (mediaErrorCode === 2) return `Não foi possível acessar “${assetName}”. Verifique se o arquivo ainda está disponível ou faça o relink.`;
  if (mediaErrorCode === 3) return `Não foi possível decodificar “${assetName}”. Gere um proxy 720p e tente novamente.`;
  return `Não foi possível reproduzir “${assetName}”. Verifique o arquivo ou gere um proxy 720p.`;
}
