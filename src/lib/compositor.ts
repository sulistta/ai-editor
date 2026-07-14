let surfaceRefreshTimer: number | undefined;

function refreshAppSurfaceNow(): void {
  if (typeof document === "undefined") return;
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!shell) return;
  const revision = shell.dataset.surfaceRevision === "1" ? "0" : "1";
  shell.dataset.surfaceRevision = revision;
  shell.style.transform = revision === "1"
    ? "translate3d(0, 0, 0)"
    : "translateZ(0)";
  void shell.offsetWidth;
}

/**
 * Invalidates the root compositing surface after a burst of canvas/video updates.
 * WebKit can otherwise keep only the most recently damaged layer when a native
 * media surface and the timeline canvas update at the same time.
 */
export function scheduleAppSurfaceRefresh(delayMs = 120): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (surfaceRefreshTimer !== undefined) window.clearTimeout(surfaceRefreshTimer);
  surfaceRefreshTimer = window.setTimeout(() => {
    surfaceRefreshTimer = undefined;
    refreshAppSurfaceNow();
  }, Math.max(0, delayMs));
}
