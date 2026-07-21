// Tests for the self-host pixel-diff stub (#3674). This module is never bundled into the Worker entry
// (scripts/build-selfhost.ts swaps it in only when building src/server.ts — see
// test/unit/worker-entry-boundary.test.ts for the enforced side of that), so it's safe to depend on real
// PNG fixtures / Buffer here, mirroring test/unit/visual-diff.test.ts's own fixture style.
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { compareCapturedScreenshots, isVisualDiffAvailable } from "../../src/selfhost/stubs/pixel-diff";

function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) << 2;
      png.data[idx] = rgba[0];
      png.data[idx + 1] = rgba[1];
      png.data[idx + 2] = rgba[2];
      png.data[idx + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

describe("selfhost pixel-diff stub (#3674)", () => {
  it("reports diffing as available", () => {
    expect(isVisualDiffAvailable()).toBe(true);
  });

  it("returns null when both screenshots are missing", async () => {
    await expect(compareCapturedScreenshots(null, null)).resolves.toBeNull();
    await expect(compareCapturedScreenshots(undefined, undefined)).resolves.toBeNull();
  });

  it("flags a real visual change with a diff image and changed-pixel percentage", async () => {
    const before = new Uint8Array(createSolidPng(40, 30, [255, 255, 255, 255]));
    const after = new Uint8Array(createSolidPng(40, 30, [0, 0, 0, 255]));
    const result = await compareCapturedScreenshots(before, after);
    expect(result?.status).toBe("changed");
    expect(result?.changedPixelPercent).toBe(100);
    expect(result?.diffImagePng).toBeInstanceOf(Uint8Array);
    expect(result?.diffImagePng?.length).toBeGreaterThan(0);
  });

  it("marks identical screenshots unchanged without a diff image", async () => {
    const png = new Uint8Array(createSolidPng(32, 24, [10, 20, 30, 255]));
    const result = await compareCapturedScreenshots(png, png);
    expect(result).toEqual({ status: "unchanged", changedPixelPercent: 0, diffImagePng: null });
  });

  it("treats a missing before (new page) as status 'new' with no diff image", async () => {
    const after = new Uint8Array(createSolidPng(10, 10, [1, 2, 3, 255]));
    const result = await compareCapturedScreenshots(null, after);
    expect(result?.status).toBe("new");
    expect(result?.diffImagePng).toBeNull();
  });

  it("treats a missing after (removed page) as status 'removed' with no diff image", async () => {
    const before = new Uint8Array(createSolidPng(10, 10, [1, 2, 3, 255]));
    const result = await compareCapturedScreenshots(before, null);
    expect(result?.status).toBe("removed");
    expect(result?.diffImagePng).toBeNull();
  });

  it("degrades to null when the input bytes aren't a valid PNG (never throws)", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const valid = new Uint8Array(createSolidPng(10, 10, [1, 2, 3, 255]));
    await expect(compareCapturedScreenshots(garbage, valid)).resolves.toBeNull();
  });
});
