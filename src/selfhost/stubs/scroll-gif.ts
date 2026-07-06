// Self-host replacement for src/review/visual/scroll-gif.ts (#3612). Swapped in by
// scripts/build-selfhost.mjs's esbuild plugin, the same mechanism used for pixel-diff and
// @cloudflare/puppeteer — this file is only ever bundled into dist/server.mjs, never the Worker entry, so
// it's safe to depend on pngjs (Node `Buffer` + PNG decode) and gifenc (pure-JS GIF encode, no ffmpeg/native
// dependency — Workers-safe by itself, but useless here without the PNG-decode step next to it) here.
import { PNG } from "pngjs";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import type { ScrollGifFrame } from "../../review/visual/scroll-gif";

export function isScrollGifAvailable(): boolean {
  return true;
}

export async function encodeScrollGif(frames: readonly ScrollGifFrame[], frameDelayMs: number): Promise<Uint8Array | null> {
  if (frames.length === 0) return null;
  try {
    const decoded = frames.map((frame) => PNG.sync.read(Buffer.from(frame.png)));
    const { width, height } = decoded[0]!;
    // Every frame comes from the same viewport-cropped capture loop, so dimensions should always match —
    // treat a mismatch as a decode/capture inconsistency and degrade to null rather than emit a corrupt GIF.
    if (decoded.some((image) => image.width !== width || image.height !== height)) return null;

    // One shared palette across every frame (quantized over ALL frames' pixels, not just the first) avoids a
    // per-frame palette switch flickering colors that are consistent across the real page.
    const allPixels = Buffer.concat(decoded.map((image) => image.data));
    const palette = quantize(allPixels, 256);

    const gif = GIFEncoder();
    decoded.forEach((image, index) => {
      const indexed = applyPalette(image.data, palette);
      gif.writeFrame(indexed, width, height, { palette, delay: frameDelayMs, first: index === 0, repeat: 0 });
    });
    gif.finish();
    return gif.bytes();
  } catch {
    return null;
  }
}
