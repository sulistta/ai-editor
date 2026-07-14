import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../types";
import { autoTranscriptionDecision } from "./transcription";

const asset: MediaAsset = {
  id: "asset",
  name: "interview.mp4",
  path: "/media/interview.mp4",
  durationTicks: 240_000,
  hasAudio: true,
  offline: false,
};

describe("automatic transcription eligibility", () => {
  it("queues supported imports when a model is ready", () => {
    expect(autoTranscriptionDecision(asset, { desktop: true, hasModel: true, hasTranscript: false })).toBe("ready");
  });

  it("waits for a model without losing the imported asset", () => {
    expect(autoTranscriptionDecision(asset, { desktop: true, hasModel: false, hasTranscript: false })).toBe("waiting-model");
  });

  it("skips media without audio and existing transcripts", () => {
    expect(autoTranscriptionDecision({ ...asset, hasAudio: false }, { desktop: true, hasModel: true, hasTranscript: false })).toBe("no-audio");
    expect(autoTranscriptionDecision(asset, { desktop: true, hasModel: true, hasTranscript: true })).toBe("complete");
  });

  it("does not schedule files unavailable to the desktop runtime", () => {
    expect(autoTranscriptionDecision({ ...asset, offline: true }, { desktop: true, hasModel: true, hasTranscript: false })).toBe("unavailable");
    expect(autoTranscriptionDecision(asset, { desktop: false, hasModel: true, hasTranscript: false })).toBe("unavailable");
  });
});
