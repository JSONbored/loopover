// Pixel-comparison provider seam for the before/after capture pipeline (#3674). WORKER-SAFE DEFAULT: a no-op.
//
// The real screenshot-comparison logic (the self-host-only module under `src/visual-agent/`) depends on
// Node's `Buffer` and a native-leaning PNG-decode step, which the Cloudflare Workers runtime doesn't
// guarantee — that's why `test/unit/worker-entry-boundary.test.ts` forbids importing (or even naming, in
// worker-reachable file content) that module from the Worker entry (`src/index.ts`). This file is the seam:
// `capture.ts` (which IS Worker-reachable) imports ONLY this file, never the self-host module directly.
// `scripts/build-selfhost.ts`'s esbuild plugin swaps this exact specifier for a real implementation when
// bundling the self-host entry (`src/server.ts`) — the SAME module-substitution pattern already used for
// `@cloudflare/puppeteer` in that same build. The Worker's own (wrangler) bundle never applies that swap, so
// hosted mode always uses this no-op — zero behavior change, zero added cost, until a Workers-compatible
// pixel-comparison path exists.
export type VisualDiffOutcome = {
  status: "changed" | "unchanged" | "new" | "removed";
  changedPixelPercent: number | null;
  diffImagePng: Uint8Array | null;
};

/** True when this build can actually compute a pixel diff (self-host only, see module header). Callers use
 *  this to decide whether it's worth paying the extra cost of holding/fetching screenshot bytes at all —
 *  always false here, so nothing about the existing capture path changes in hosted mode. */
export function isVisualDiffAvailable(): boolean {
  return false;
}

/** Compare two screenshots. Always null in the Worker-safe default — self-host's swapped-in implementation
 *  does the real comparison. Callers must treat null as "no diff available for this cell", never a failure. */
export async function compareCapturedScreenshots(
  _before: Uint8Array | null | undefined,
  _after: Uint8Array | null | undefined,
): Promise<VisualDiffOutcome | null> {
  return null;
}
