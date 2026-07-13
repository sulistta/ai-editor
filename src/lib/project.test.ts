import { describe, expect, it } from "vitest";
import { applyTransaction, captionsFromTranscript, createEmptyProject, makeClip, sequenceDuration } from "./project";
import { secondsToTicks } from "./time";

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
});
