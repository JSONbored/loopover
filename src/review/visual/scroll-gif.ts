// Scroll-through GIF assembly seam for the before/after capture pipeline (#3612). WORKER-SAFE DEFAULT: a no-op.
//
// A scroll-linked interaction (parallax, reveal-on-scroll, a sticky header) isn't visible in a single static
// screenshot — this assembles a short sequence of viewport-cropped frames (captured while scrolling down the
// page, see `captureScrollFrames` in ./shot) into one animated image. Turning those frames into a real
// animated image needs decoding each captured frame back to raw pixels, which — like the pixel-diff provider
// in ./pixel-diff — depends on Node's `Buffer` and a native-leaning image-decode step the Cloudflare Workers
// runtime doesn't guarantee. `test/unit/worker-entry-boundary.test.ts` enforces the same boundary here as it
// does for the pixel-diff module. `capture.ts` (Worker-reachable) imports ONLY this file; never the self-host
// module directly. `scripts/build-selfhost.mjs`'s esbuild plugin swaps this exact specifier for a real
// implementation when bundling the self-host entry (`src/server.ts`) — the same module-substitution pattern
// already used for pixel-diff and `@cloudflare/puppeteer` in that same build. The Worker's own (wrangler)
// bundle never applies that swap, so hosted mode always uses this no-op — zero behavior change, zero added
// capture cost, until a Workers-compatible image-decode path exists.
export type ScrollGifFrame = { png: Uint8Array };

/** True when this build can actually assemble a scroll-through GIF (self-host only, see module header).
 *  Callers use this to decide whether it's worth paying the extra cost of capturing stepped scroll frames at
 *  all — always false here, so nothing about the existing capture path changes in hosted mode. */
export function isScrollGifAvailable(): boolean {
  return false;
}

/** Assemble captured frames into an animated image. Always null in the Worker-safe default — self-host's
 *  swapped-in implementation does the real encode. Callers must treat null as "no GIF available", never a
 *  failure — a missing GIF degrades the collapsible section to omitting that route, not an error. */
export async function encodeScrollGif(_frames: readonly ScrollGifFrame[], _frameDelayMs: number): Promise<Uint8Array | null> {
  return null;
}
