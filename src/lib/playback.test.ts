import { describe, expect, it } from "vitest";
import type { Sequence, TimelineClip, TimelineTrack } from "../types";
import { activeAudioPlaybackItems, activePlaybackItem, activeVideoPlaybackItem, isCurrentCompatibilityProxy, mediaSecondsToTimelineTick, mediaVolume, needsCompatibilityProxy, playbackFailureMessage, playbackItemAtOrAfter, playbackItems, playbackRecoveryAction, programPreviewTick, resolvePlaybackAsset, timelineTickToMediaSeconds } from "./playback";

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
    keyframes: [],
    effects: [],
  };
}

function track(id: string, kind: TimelineTrack["kind"], clips: TimelineClip[], patch: Partial<TimelineTrack> = {}): TimelineTrack {
  return { id, name: id, kind, clips, locked: false, muted: false, hidden: false, ...patch };
}

function sequence(tracks: TimelineTrack[]): Sequence {
  return { id: "sequence", name: "Sequence", tracks, markers: [], captions: [], captionStyle: { fontFamily: "modern", fontSize: 48, textColor: "#FFFFFF", background: true, backgroundColor: "#000000", uppercase: false, bold: true, position: "bottom" } };
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

  it("separates the visible program layer from every audible layer", () => {
    const items = playbackItems(sequence([
      track("video-low", "video", [clip("video-low")]),
      track("audio", "audio", [clip("audio")]),
      track("muted-audio", "audio", [clip("muted-audio")], { muted: true }),
      track("video-high", "video", [clip("video-high")]),
    ]));
    expect(activeVideoPlaybackItem(items, 1)?.clip.id).toBe("video-high");
    expect(activeAudioPlaybackItems(items, 1).map((item) => item.clip.id)).toEqual(["video-low", "audio", "video-high"]);
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

  it("clamps mapping to the clip source window", () => {
    const item = clip("bounded");
    expect(timelineTickToMediaSeconds(item, -10)).toBe(0.5);
    expect(timelineTickToMediaSeconds(item, 480_000)).toBe(2.5);
  });

  it("maps media time back to a bounded timeline tick", () => {
    const item = clip("inverse");
    expect(mediaSecondsToTimelineTick(item, 1)).toBe(60_000);
    expect(mediaSecondsToTimelineTick(item, -1)).toBe(0);
    expect(mediaSecondsToTimelineTick(item, 100)).toBe(240_000);
  });

  it("keeps the final frame mounted when the playhead reaches the sequence end", () => {
    expect(programPreviewTick(2_400_000, 2_400_000, 8_000)).toBe(2_392_000);
    expect(programPreviewTick(1_200_000, 2_400_000, 8_000)).toBe(1_200_000);
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

  it("buffers a valid current proxy when WebKit rejects the asset protocol", () => {
    const asset = { id: "asset", name: "clip.mp4", path: "/media/clip.mp4", proxyPath: "/cache/clip.proxy-v3.mp4", durationTicks: 1, hasAudio: true, offline: false };
    expect(playbackRecoveryAction({ asset, localSource: asset.proxyPath, desktop: true, unsupported: true })).toBe("buffer-source");
    expect(playbackRecoveryAction({ asset, localSource: asset.proxyPath, desktop: true, unsupported: true, bufferedAttempted: true })).toBe("use-original");
  });

  it("regenerates legacy proxies before falling back to buffering", () => {
    const asset = { id: "asset", name: "clip.mp4", path: "/media/clip.mp4", proxyPath: "/cache/clip.proxy-v2.webm", durationTicks: 1, hasAudio: true, offline: false };
    expect(playbackRecoveryAction({ asset, localSource: asset.proxyPath, desktop: true, unsupported: true })).toBe("generate-proxy");
  });
});
