// Image downscale provider seam (#4370, extended #6324). WORKER-SAFE DEFAULT: a no-op.
//
// The real downscale uses a native image-resizing binding that can't run on the Cloudflare Workers runtime
// — that's why `capture.ts` (which IS Worker-reachable) imports ONLY this file, never the real dependency
// directly. Mirrors the pixel-diff.ts seam exactly: `scripts/build-selfhost.ts`'s esbuild plugin swaps
// this specifier for a real implementation (`src/selfhost/stubs/image-downscale.ts`) when bundling the
// self-host entry (`src/server.ts`). The Worker's own (wrangler) bundle never applies that swap, so hosted
// mode always returns the input unchanged — zero behavior change, zero added cost.
//
// #6324 added downscaleForDisplay/isDisplayDownscaleAvailable alongside the original downscaleForVision:
// distinct purpose (a real, smaller thumbnail copy stored for the PR-comment table's <img>, not a
// vision-call-only resize), distinct target size, but the identical hosted-no-op/self-host-real seam shape.
export async function downscaleForVision(png: Uint8Array): Promise<Uint8Array> {
  return png;
}

/** True when this build can actually produce a downscaled DISPLAY copy (self-host only, see module header).
 *  Callers use this to decide whether generating + storing a separate thumbnail is worth it at all — always
 *  false here, so hosted mode never pays for a second R2 write or resize attempt that would be a no-op
 *  anyway. */
export function isDisplayDownscaleAvailable(): boolean {
  return false;
}

/** Downscale `png` for DISPLAY (the PR-comment table's embedded thumbnail) — distinct from
 *  downscaleForVision's AI-call-sized resize above. A no-op here; callers must gate on
 *  isDisplayDownscaleAvailable() rather than assume this changed anything. */
export async function downscaleForDisplay(png: Uint8Array): Promise<Uint8Array> {
  return png;
}
