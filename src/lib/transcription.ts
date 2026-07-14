import type { MediaAsset } from "../types";

export type AutoTranscriptionDecision = "ready" | "waiting-model" | "complete" | "no-audio" | "unavailable";

export function autoTranscriptionDecision(
  asset: MediaAsset,
  context: { desktop: boolean; hasModel: boolean; hasTranscript: boolean },
): AutoTranscriptionDecision {
  if (context.hasTranscript) return "complete";
  if (!asset.hasAudio) return "no-audio";
  if (!context.desktop || !asset.path || asset.offline) return "unavailable";
  if (!context.hasModel) return "waiting-model";
  return "ready";
}
