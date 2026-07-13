import { describe, expect, it } from "vitest";
import { formatTimecode, frameDurationTicks, parseTimestamp, secondsToTicks, snapTickToFrame } from "./time";

describe("timeline time", () => {
  it("uses a timebase compatible with common frame rates", () => {
    expect(frameDurationTicks(24)).toBe(10_000);
    expect(frameDurationTicks(30_000, 1_001)).toBe(8_008);
    expect(frameDurationTicks(60_000, 1_001)).toBe(4_004);
  });

  it("snaps edits to frame boundaries", () => {
    expect(snapTickToFrame(12_499, 24)).toBe(10_000);
    expect(snapTickToFrame(15_001, 24)).toBe(20_000);
  });

  it("formats and parses editor time", () => {
    expect(formatTimecode(secondsToTicks(65.5), 30)).toBe("00:01:05:15");
    expect(parseTimestamp("01:05.5")).toBe(secondsToTicks(65.5));
  });
});
