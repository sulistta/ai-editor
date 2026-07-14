import { describe, expect, it } from "vitest";
import { EditorStore } from "./EditorContext";

describe("EditorStore lifecycle", () => {
  it("accepts edits after the StrictMode setup-cleanup-setup cycle", async () => {
    const store = new EditorStore();
    await store.initialize();
    store.dispose();
    await store.initialize();

    await store.actions.importAsset({
      id: "asset",
      name: "interview.mp4",
      durationTicks: 240_000,
      hasAudio: true,
      offline: false,
    });

    expect(store.getSnapshot().project.assets).toHaveLength(1);
    expect(store.getSnapshot().project.assets[0]?.id).toBe("asset");
    store.dispose();
  });
});
