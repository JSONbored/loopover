// Self-host replacement for src/review/visual/image-downscale.ts (#4370). Swapped in by
// scripts/build-selfhost.ts's esbuild plugin, the same mechanism used for @cloudflare/puppeteer and
// ./pixel-diff — this file is only ever bundled into dist/server.mjs, never the Worker entry, so it's safe
// to depend on sharp (a native binding) here. Unlike puppeteer-core, sharp is marked `external` in the
// --all esbuild bundle (a native binding can't be bundled) and installed separately into the runtime Docker
// image (see the Dockerfile) rather than lazily imported at call time — sharp has no browser-sidecar-style
// opt-in the way puppeteer-core does, so a plain static import is fine.
import sharp from "sharp";

/** Longest-edge cap for the bytes sent to the local VLM — NOT the stored/displayed screenshot (the same URL
 *  is embedded verbatim in the PR comment; see review/visual/capture.ts's unified-comment-bridge caller).
 *  shot.ts captures `fullPage: true`, so image HEIGHT scales with the page's full scrollable content even
 *  though the viewport is a fixed 1440px wide — Qwen's dynamic-resolution vision encoder tokenizes
 *  proportional to pixel count, so an oversized tall page inflates vision prefill cost/latency for no
 *  quality gain a human reviewer would notice at chat-image resolution. */
const VISION_MAX_DIMENSION_PX = 1280;

/** Downscale `png` so its longest edge is at most {@link VISION_MAX_DIMENSION_PX}, preserving aspect ratio
 *  and never enlarging an already-small image. Any decode/resize failure (a corrupt/unexpected payload)
 *  degrades to the ORIGINAL bytes rather than dropping the image — a vision call on a full-size image is
 *  strictly better than no image at all. */
export async function downscaleForVision(png: Uint8Array): Promise<Uint8Array> {
  try {
    const resized = await sharp(png)
      .resize({ width: VISION_MAX_DIMENSION_PX, height: VISION_MAX_DIMENSION_PX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return new Uint8Array(resized);
  } catch {
    return png;
  }
}

/** True in self-host mode -- see image-downscale.ts's module header for why hosted mode can never do this. */
export function isDisplayDownscaleAvailable(): boolean {
  return true;
}

/** Width cap for the DISPLAY thumbnail embedded in the PR-comment table (#6324) -- distinct from
 *  VISION_MAX_DIMENSION_PX above (a different caller, a different constraint). shot.ts's DESKTOP_VIEWPORT is
 *  1440px wide; the table embeds the image at `width="360"` (a GitHub-rendered thumbnail), so every viewer's
 *  browser previously downloaded the full native-resolution capture just to display it shrunk 4x. 720px is
 *  2x the display width -- sharp enough for a HiDPI/retina viewer, still a real reduction from 1440px (and a
 *  much larger one for a tall full-page capture, since height scales down proportionally too). */
const DISPLAY_MAX_WIDTH_PX = 720;

/** Height cap for the DISPLAY thumbnail, alongside {@link DISPLAY_MAX_WIDTH_PX} -- fixes a real bug (observed
 *  live on a mobile capture table cell): shot.ts's `fullPage: true` capture means HEIGHT is unbounded by the
 *  viewport, and a NARROW capture (shot.ts's MOBILE_VIEWPORT is 390px, already under DISPLAY_MAX_WIDTH_PX)
 *  passed straight through a width-only resize untouched via `withoutEnlargement` -- a several-thousand-pixel-
 *  tall full-page mobile screenshot rendered at its native size in the comment table instead of a bounded
 *  thumbnail. Same value as VISION_MAX_DIMENSION_PX -- both are "a reasonable bounded preview", no reason for
 *  the two budgets to diverge. */
const DISPLAY_MAX_HEIGHT_PX = 1280;

/** Downscale `png` so its width is at most {@link DISPLAY_MAX_WIDTH_PX} AND its height is at most
 *  {@link DISPLAY_MAX_HEIGHT_PX} (`fit: "inside"` -- whichever bound is hit first wins, aspect ratio
 *  preserved), never enlarging an already-small image (a mobile-viewport capture short enough to clear both
 *  caps passes through unchanged rather than being upscaled). Any decode/resize failure degrades to the
 *  ORIGINAL bytes, matching downscaleForVision's own "a full-size image beats no image" contract --
 *  capturePage's caller falls back to the original URL entirely when this genuinely can't produce a smaller
 *  copy, so a failure here is never user-visible as a broken image, only as a missed optimization. */
export async function downscaleForDisplay(png: Uint8Array): Promise<Uint8Array> {
  try {
    const resized = await sharp(png)
      .resize({ width: DISPLAY_MAX_WIDTH_PX, height: DISPLAY_MAX_HEIGHT_PX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    return new Uint8Array(resized);
  } catch {
    return png;
  }
}
