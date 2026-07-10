// Tests for the self-host vision-image-downscale stub (#4370). This module is never bundled into the
// Worker entry (scripts/build-selfhost.mjs swaps it in only when building src/server.ts — see
// test/unit/worker-entry-boundary.test.ts for the enforced side of that), so it's safe to depend on sharp
// / real PNG fixtures here, mirroring test/unit/selfhost-pixel-diff-stub.test.ts's own fixture style.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { downscaleForVision } from "../../src/selfhost/stubs/image-downscale";

async function solidPng(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

async function dimensionsOf(png: Uint8Array): Promise<{ width: number; height: number }> {
  const meta = await sharp(Buffer.from(png)).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

describe("selfhost image-downscale stub (#4370)", () => {
  it("downscales a wide image so the longest edge (width) is capped, preserving aspect ratio", async () => {
    const wide = await solidPng(2000, 500);
    const result = await downscaleForVision(wide);
    const { width, height } = await dimensionsOf(result);
    expect(width).toBe(1280);
    expect(height).toBe(320); // 500/2000 * 1280
  });

  it("downscales a tall image (the real fullPage-capture shape) so the longest edge (height) is capped", async () => {
    const tall = await solidPng(500, 2000);
    const result = await downscaleForVision(tall);
    const { width, height } = await dimensionsOf(result);
    expect(height).toBe(1280);
    expect(width).toBe(320); // 500/2000 * 1280
  });

  it("leaves an already-small image's dimensions unchanged (withoutEnlargement)", async () => {
    const small = await solidPng(800, 600);
    const result = await downscaleForVision(small);
    const { width, height } = await dimensionsOf(result);
    expect(width).toBe(800);
    expect(height).toBe(600);
  });

  it("degrades to the ORIGINAL bytes (never drops the image) when the input isn't a valid image", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await downscaleForVision(garbage);
    expect(result).toBe(garbage);
  });
});
