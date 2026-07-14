import { describe, expect, it } from "vitest";
import { applyTransaction, captionsFromTranscript, createEmptyProject, makeClip, sequenceDuration } from "./project";
import { secondsToTicks } from "./time";
import { transformAtTimelineTick } from "./transform";

describe("project command bus", () => {
  it("inserts and splits a clip without changing its total duration", () => {
    const project = createEmptyProject();
    const asset = { id: "asset-1", name: "clip.mp4", durationTicks: secondsToTicks(10), hasAudio: true, offline: false };
    const track = project.sequences[0]!.tracks[0]!;
    const clip = makeClip(asset, 0);
    let next = applyTransaction(project, {
      id: "tx-1",
      baseRevision: 0,
      source: "manual",
      label: "Inserir mídia",
      commands: [{ type: "addAsset", asset }, { type: "insertClip", trackId: track.id, clip }],
    });
    next = applyTransaction(next, {
      id: "tx-2",
      baseRevision: 1,
      source: "manual",
      label: "Dividir clipe",
      commands: [{ type: "splitClip", trackId: track.id, clipId: clip.id, atTick: secondsToTicks(4), rightClipId: "right" }],
    });
    expect(next.sequences[0]!.tracks[0]!.clips).toHaveLength(2);
    expect(sequenceDuration(next.sequences[0]!)).toBe(secondsToTicks(10));
  });

  it("rejects stale transactions", () => {
    const project = createEmptyProject();
    expect(() => applyTransaction(project, { id: "stale", baseRevision: 3, source: "manual", label: "stale", commands: [] })).toThrow(
      /Revisão desatualizada/,
    );
  });

  it("maps source transcript time into a trimmed, repositioned clip", () => {
    const project = createEmptyProject();
    const asset = { id: "asset-1", name: "clip.mp4", durationTicks: secondsToTicks(20), hasAudio: true, offline: false };
    project.assets.push(asset);
    project.sequences[0]!.tracks[0]!.clips.push({
      ...makeClip(asset, secondsToTicks(5)),
      sourceInTick: secondsToTicks(1),
      durationTicks: secondsToTicks(2),
      speed: 2,
    });
    const captions = captionsFromTranscript(project, {
      assetId: asset.id,
      engine: "whisper.cpp",
      model: "test",
      segments: [{ id: "segment", startTick: secondsToTicks(2), endTick: secondsToTicks(3), text: "Trecho" }],
    });
    expect(captions[0]).toMatchObject({ startTick: secondsToTicks(5.5), endTick: secondsToTicks(6), text: "Trecho" });
  });

  it("preserves animated transform continuity when splitting a clip", () => {
    const project = createEmptyProject();
    const asset = { id: "asset-1", name: "clip.mp4", durationTicks: secondsToTicks(10), hasAudio: true, offline: false };
    const track = project.sequences[0]!.tracks[0]!;
    const clip = makeClip(asset, 0);
    clip.keyframes = [
      { id: "start", offsetTick: 0, easing: "linear", value: { ...clip.transform } },
      { id: "end", offsetTick: secondsToTicks(10), easing: "linear", value: { ...clip.transform, x: 100, scale: 2 } },
    ];
    const inserted = applyTransaction(project, {
      id: "insert",
      baseRevision: 0,
      source: "manual",
      label: "Inserir mídia animada",
      commands: [{ type: "addAsset", asset }, { type: "insertClip", trackId: track.id, clip }],
    });
    const expectedAtSplit = transformAtTimelineTick(clip, secondsToTicks(4));
    const split = applyTransaction(inserted, {
      id: "split",
      baseRevision: 1,
      source: "manual",
      label: "Dividir mídia animada",
      commands: [{ type: "splitClip", trackId: track.id, clipId: clip.id, atTick: secondsToTicks(4), rightClipId: "right" }],
    });
    const [left, right] = split.sequences[0]!.tracks[0]!.clips;
    expect(transformAtTimelineTick(left!, left!.startTick + left!.durationTicks)).toMatchObject(expectedAtSplit);
    expect(transformAtTimelineTick(right!, right!.startTick)).toMatchObject(expectedAtSplit);
    expect(transformAtTimelineTick(right!, right!.startTick + secondsToTicks(3))).toMatchObject({ x: 70, scale: 1.7 });
  });

  it("preserves the source span and animation timing when speed changes", () => {
    const project = createEmptyProject();
    const asset = { id: "asset-1", name: "clip.mp4", durationTicks: secondsToTicks(10), hasAudio: true, offline: false };
    const track = project.sequences[0]!.tracks[0]!;
    const clip = makeClip(asset, 0);
    clip.keyframes = [
      { id: "start", offsetTick: 0, easing: "linear", value: { ...clip.transform } },
      { id: "middle", offsetTick: secondsToTicks(5), easing: "linear", value: { ...clip.transform, x: 50 } },
      { id: "end", offsetTick: secondsToTicks(10), easing: "linear", value: { ...clip.transform, x: 100 } },
    ];
    const inserted = applyTransaction(project, {
      id: "insert",
      baseRevision: 0,
      source: "manual",
      label: "Inserir mídia animada",
      commands: [{ type: "addAsset", asset }, { type: "insertClip", trackId: track.id, clip }],
    });
    const spedUp = applyTransaction(inserted, {
      id: "speed",
      baseRevision: 1,
      source: "manual",
      label: "Acelerar mídia",
      commands: [{ type: "updateClip", trackId: track.id, clipId: clip.id, patch: { speed: 2 } }],
    });
    const result = spedUp.sequences[0]!.tracks[0]!.clips[0]!;
    expect(result.durationTicks * result.speed).toBe(clip.durationTicks * clip.speed);
    expect(result.keyframes.map((keyframe) => keyframe.offsetTick)).toEqual([
      0,
      secondsToTicks(2.5),
      secondsToTicks(5),
    ]);
    expect(transformAtTimelineTick(result, secondsToTicks(2.5))).toMatchObject({ x: 50 });
  });

  it("keeps the interpolated final frame when trimming an animated clip", () => {
    const project = createEmptyProject();
    const asset = { id: "asset-1", name: "clip.mp4", durationTicks: secondsToTicks(10), hasAudio: true, offline: false };
    const track = project.sequences[0]!.tracks[0]!;
    const clip = makeClip(asset, 0);
    clip.keyframes = [
      { id: "start", offsetTick: 0, easing: "linear", value: { ...clip.transform } },
      { id: "end", offsetTick: secondsToTicks(10), easing: "linear", value: { ...clip.transform, x: 100 } },
    ];
    const inserted = applyTransaction(project, {
      id: "insert",
      baseRevision: 0,
      source: "manual",
      label: "Inserir mídia animada",
      commands: [{ type: "addAsset", asset }, { type: "insertClip", trackId: track.id, clip }],
    });
    const trimmed = applyTransaction(inserted, {
      id: "trim",
      baseRevision: 1,
      source: "manual",
      label: "Aparar mídia animada",
      commands: [{ type: "trimClip", trackId: track.id, clipId: clip.id, sourceInTick: 0, durationTicks: secondsToTicks(4) }],
    });
    const result = trimmed.sequences[0]!.tracks[0]!.clips[0]!;
    expect(transformAtTimelineTick(result, result.durationTicks)).toMatchObject({ x: 40 });
    expect(result.keyframes.at(-1)?.offsetTick).toBe(result.durationTicks);
  });
});
