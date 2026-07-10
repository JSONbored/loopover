// Vision-image downscale provider seam (#4370). WORKER-SAFE DEFAULT: a no-op.
//
// The real downscale uses a native image-resizing binding that can't run on the Cloudflare Workers runtime
// — that's why `capture.ts` (which IS Worker-reachable) imports ONLY this file, never the real dependency
// directly. Mirrors the pixel-diff.ts seam exactly: `scripts/build-selfhost.mjs`'s esbuild plugin swaps
// this specifier for a real implementation (`src/selfhost/stubs/image-downscale.ts`) when bundling the
// self-host entry (`src/server.ts`). The Worker's own (wrangler) bundle never applies that swap, so hosted
// mode always returns the input unchanged — zero behavior change, zero added cost.
export async function downscaleForVision(png: Uint8Array): Promise<Uint8Array> {
  return png;
}
