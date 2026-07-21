// Self-host replacement for src/review/visual/pixel-diff.ts (#3674). Swapped in by
// scripts/build-selfhost.ts's esbuild plugin, the same mechanism used for @cloudflare/puppeteer — this
// file is only ever bundled into dist/server.mjs, never the Worker entry, so it's safe to depend on
// pixelmatch/pngjs (Node `Buffer` + PNG decode) here. Unlike puppeteer-core, pixelmatch/pngjs are
// unconditional package.json dependencies (no INSTALL_VISUAL_REVIEW-style opt-in), so a plain static
// import is fine — no lazy runtime import needed.
import { compareRouteScreenshots } from "../../visual-agent/visual-diff";
import type { VisualDiffOutcome } from "../../review/visual/pixel-diff";

export function isVisualDiffAvailable(): boolean {
  return true;
}

export async function compareCapturedScreenshots(
  before: Uint8Array | null | undefined,
  after: Uint8Array | null | undefined,
): Promise<VisualDiffOutcome | null> {
  if (!before && !after) return null;
  try {
    const result = compareRouteScreenshots({
      route: "",
      before: before ? Buffer.from(before) : null,
      after: after ? Buffer.from(after) : null,
    });
    return {
      status: result.status,
      changedPixelPercent: result.changedPixelPercent,
      diffImagePng: result.diffImagePng ? new Uint8Array(result.diffImagePng) : null,
    };
  } catch {
    return null;
  }
}
