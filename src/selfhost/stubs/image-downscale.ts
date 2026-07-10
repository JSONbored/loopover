// Self-host replacement for src/review/visual/image-downscale.ts (#4370). Swapped in by
// scripts/build-selfhost.mjs's esbuild plugin, the same mechanism used for @cloudflare/puppeteer and
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
