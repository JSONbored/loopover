// Tests for the self-host vision-image-downscale stub (#4370). This module is never bundled into the
// Worker entry (scripts/build-selfhost.ts swaps it in only when building src/server.ts — see
// test/unit/worker-entry-boundary.test.ts for the enforced side of that), so it's safe to depend on sharp
// / real PNG fixtures here, mirroring test/unit/selfhost-pixel-diff-stub.test.ts's own fixture style.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { downscaleForDisplay, downscaleForVision, isDisplayDownscaleAvailable } from "../../src/selfhost/stubs/image-downscale";

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

describe("selfhost image-downscale stub, display copy (#6324)", () => {
  it("isDisplayDownscaleAvailable is true -- this IS the real self-host implementation", () => {
    expect(isDisplayDownscaleAvailable()).toBe(true);
  });

  it("downscales a desktop-width capture (1440px, shot.ts's DESKTOP_VIEWPORT) so width is capped at 720, preserving aspect ratio", async () => {
    const desktopShot = await solidPng(1440, 2397); // the exact dimensions observed live on JSONbored/metagraphed#6036
    const result = await downscaleForDisplay(desktopShot);
    const { width, height } = await dimensionsOf(result);
    expect(width).toBe(720);
    expect(height).toBe(1199); // round(2397/1440 * 720) = round(1198.5) = 1199
    expect(result.byteLength).toBeLessThan(desktopShot.byteLength);
  });

  it("leaves an already-narrow, normal-height image's dimensions unchanged (withoutEnlargement) -- e.g. a mobile-viewport capture that isn't full-page", async () => {
    const mobileShot = await solidPng(390, 844);
    const result = await downscaleForDisplay(mobileShot);
    const { width, height } = await dimensionsOf(result);
    expect(width).toBe(390);
    expect(height).toBe(844);
  });

  it("bug fix: downscales a NARROW but very TALL image (a mobile full-page capture) so height is capped too, not just width", async () => {
    // The real shape that shipped huge, un-downscaled screenshots in a PR comment table: shot.ts's mobile
    // viewport is 390px wide (already under DISPLAY_MAX_WIDTH_PX), but `fullPage: true` means height is
    // unbounded by the viewport -- a width-only resize (the original bug) left this completely untouched.
    const tallMobileShot = await solidPng(390, 5000);
    const result = await downscaleForDisplay(tallMobileShot);
    const { width, height } = await dimensionsOf(result);
    expect(height).toBe(1280);
    expect(width).toBe(100); // round(390/5000 * 1280) = round(99.84) = 100
    expect(result.byteLength).toBeLessThan(tallMobileShot.byteLength);
  });

  it("degrades to the ORIGINAL bytes (never drops the image) when the input isn't a valid image", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await downscaleForDisplay(garbage);
    expect(result).toBe(garbage);
  });
});
