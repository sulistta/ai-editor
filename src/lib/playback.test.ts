import { describe, expect, it } from "vitest";
import type { Sequence, TimelineClip, TimelineTrack } from "../types";
import { activePlaybackItem, isCurrentCompatibilityProxy, mediaVolume, needsCompatibilityProxy, playbackFailureMessage, playbackItemAtOrAfter, playbackItems, resolvePlaybackAsset, timelineTickToMediaSeconds } from "./playback";

function clip(id: string, startTick = 0, durationTicks = 240_000): TimelineClip {
  return {
    id,
    assetId: `asset-${id}`,
    name: id,
    startTick,
    sourceInTick: 120_000,
    durationTicks,
    speed: 2,
    volume: 0.75,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0 },
    effects: [],
  };
}

function track(id: string, kind: TimelineTrack["kind"], clips: TimelineClip[], patch: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, name: id, kind, clips, locked: false, muted: false, hidden: false, ...patch };
}

function sequence(tracks: TimelineTrack[]): Sequence {
  return { id: "sequence", name: "Sequence", tracks, markers: [], captions: [] };
}

describe("playback selection", () => {
  it("prioritizes the top visible video over overlapping audio", () => {
    const items = playbackItems(sequence([
      track("audio", "audio", [clip("audio")]),
      track("video-low", "video", [clip("video-low")]),
      track("video-high", "video", [clip("video-high")]),
    ]));
    expect(activePlaybackItem(items, 1)?.clip.id).toBe("video-high");
  });

  it("plays audio-only timelines and skips hidden tracks", () => {
    const items = playbackItems(sequence([
      track("hidden-video", "video", [clip("hidden")], { hidden: true }),
      track("audio", "audio", [clip("audio")]),
    ]));
    expect(activePlaybackItem(items, 1)?.clip.id).toBe("audio");
  });

  it("finds the next clip when the playhead is in a gap", () => {
    const items = playbackItems(sequence([track("video", "video", [clip("later", 480_000)])]));
    expect(playbackItemAtOrAfter(items, 240_000)?.clip.id).toBe("later");
  });

  it("resolves a selected asset even before it has a timeline clip", () => {
    const selected = { id: "selected", name: "selected.mp4", durationTicks: 240_000, hasAudio: true, offline: false };
    expect(resolvePlaybackAsset([selected], undefined, "selected")).toBe(selected);
  });
});

describe("playback media mapping", () => {
  it("maps timeline time through source in and speed", () => {
    expect(timelineTickToMediaSeconds(clip("mapped"), 60_000)).toBe(1);
  });

  it("applies track mute and clamps HTML media volume", () => {
    const item = clip("volume");
    item.volume = 2;
    expect(mediaVolume(item, track("video", "video", [item], { muted: true }))).toEqual({ muted: true, volume: 1 });
  });

  it("returns an actionable message for unsupported media", () => {
    expect(playbackFailureMessage("camera.mkv", undefined, 4)).toContain("proxy 720p");
  });

  it("requests proxies only for known incompatible video codecs", () => {
    expect(needsCompatibilityProxy({ codec: "av1", width: 1920, height: 1080 })).toBe(true);
    expect(needsCompatibilityProxy({ codec: "vp9", width: 1920, height: 1080 })).toBe(true);
    expect(needsCompatibilityProxy({ codec: "h264", width: 1920, height: 1080 })).toBe(false);
    expect(needsCompatibilityProxy({ codec: "aac", width: undefined, height: undefined })).toBe(false);
  });

  it("recognizes only the current H.264 proxy generation", () => {
    expect(isCurrentCompatibilityProxy("/cache/media.proxy-v3.mp4")).toBe(true);
    expect(isCurrentCompatibilityProxy("/cache/media.proxy-v2.webm")).toBe(false);
  });
});
