import type { KeyframeEasing, TimelineClip, Transform, TransformKeyframe } from "../types";

const transformFields: Array<keyof Transform> = [
  "x",
  "y",
  "scale",
  "rotation",
  "opacity",
  "cropTop",
  "cropRight",
  "cropBottom",
  "cropLeft",
];

export function easingProgress(value: number, easing: KeyframeEasing): number {
  const progress = Math.min(1, Math.max(0, value));
  if (easing === "easeIn") return progress * progress;
  if (easing === "easeOut") return 1 - (1 - progress) * (1 - progress);
  if (easing === "easeInOut") return progress < 0.5
    ? 2 * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
  return progress;
}

export function interpolateTransform(from: Transform, to: Transform, progress: number, easing: KeyframeEasing = "linear"): Transform {
  const amount = easingProgress(progress, easing);
  const output = { ...from };
  for (const field of transformFields) output[field] = from[field] + (to[field] - from[field]) * amount;
  return output;
}

export function transformAtOffset(base: Transform, keyframes: TransformKeyframe[], offsetTick: number): Transform {
  if (keyframes.length === 0) return base;
  const boundedOffset = Math.max(0, offsetTick);
  let previous: TransformKeyframe = { id: "base", offsetTick: 0, easing: "linear", value: base };
  for (const next of keyframes) {
    if (boundedOffset <= next.offsetTick) {
      const span = next.offsetTick - previous.offsetTick;
      if (span <= 0) return next.value;
      return interpolateTransform(previous.value, next.value, (boundedOffset - previous.offsetTick) / span, next.easing);
    }
    previous = next;
  }
  return previous.value;
}

export function transformAtTimelineTick(clip: TimelineClip, timelineTick: number): Transform {
  return transformAtOffset(clip.transform, clip.keyframes, Math.max(0, timelineTick - clip.startTick));
}

export function normalizeKeyframes(keyframes: TransformKeyframe[], durationTicks: number): TransformKeyframe[] {
  const byTick = new Map<number, TransformKeyframe>();
  for (const keyframe of keyframes) {
    const offsetTick = Math.round(Math.min(Math.max(0, durationTicks), Math.max(0, keyframe.offsetTick)));
    byTick.set(offsetTick, { ...keyframe, offsetTick });
  }
  return [...byTick.values()].sort((left, right) => left.offsetTick - right.offsetTick);
}
