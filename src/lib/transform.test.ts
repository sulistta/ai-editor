import { describe, expect, it } from "vitest";
import { EMPTY_TRANSFORM, makeClip } from "./project";
import { interpolateTransform, normalizeKeyframes, transformAtTimelineTick } from "./transform";

describe("transform animation", () => {
  it("interpolates a keyframed zoom in timeline time", () => {
    const clip = makeClip({ id: "asset", name: "video", durationTicks: 1_000, hasAudio: true, offline: false }, 200);
    clip.keyframes = [
      { id: "start", offsetTick: 0, easing: "linear", value: { ...EMPTY_TRANSFORM } },
      { id: "end", offsetTick: 1_000, easing: "linear", value: { ...EMPTY_TRANSFORM, x: 100, scale: 2 } },
    ];
    expect(transformAtTimelineTick(clip, 700)).toMatchObject({ x: 50, scale: 1.5 });
  });

  it("applies easing without changing unrelated transform fields", () => {
    const output = interpolateTransform(EMPTY_TRANSFORM, { ...EMPTY_TRANSFORM, opacity: 0 }, 0.5, "easeIn");
    expect(output.opacity).toBeCloseTo(0.75);
    expect(output.scale).toBe(1);
  });

  it("sorts, clamps and replaces duplicate keyframe ticks", () => {
    const keyframes = normalizeKeyframes([
      { id: "late", offsetTick: 200, easing: "linear", value: EMPTY_TRANSFORM },
      { id: "replacement", offsetTick: -4, easing: "linear", value: { ...EMPTY_TRANSFORM, x: 2 } },
      { id: "first", offsetTick: 0, easing: "linear", value: EMPTY_TRANSFORM },
    ], 100);
    expect(keyframes.map((item) => [item.id, item.offsetTick])).toEqual([["first", 0], ["late", 100]]);
  });
});
