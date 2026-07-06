// Tests for the self-host scroll-through-GIF stub (#3612). This module is never bundled into the Worker
// entry (scripts/build-selfhost.mjs swaps it in only when building src/server.ts — see
// test/unit/worker-entry-boundary.test.ts for the enforced side of that), so it's safe to depend on real
// PNG fixtures / Buffer here, mirroring test/unit/selfhost-pixel-diff-stub.test.ts's own fixture style.
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { encodeScrollGif, isScrollGifAvailable } from "../../src/selfhost/stubs/scroll-gif";

function createSolidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
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
  return new Uint8Array(PNG.sync.write(png));
}

function gifHeaderOf(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.slice(0, 6));
}

describe("selfhost scroll-gif stub (#3612)", () => {
  it("reports scroll-GIF assembly as available", () => {
    expect(isScrollGifAvailable()).toBe(true);
  });

  it("returns null for an empty frame list", async () => {
    await expect(encodeScrollGif([], 300)).resolves.toBeNull();
  });

  it("encodes a real GIF89a stream from multiple same-size frames", async () => {
    const frames = [
      { png: createSolidPng(20, 15, [255, 0, 0, 255]) },
      { png: createSolidPng(20, 15, [0, 255, 0, 255]) },
      { png: createSolidPng(20, 15, [0, 0, 255, 255]) },
    ];
    const gif = await encodeScrollGif(frames, 300);
    expect(gif).toBeInstanceOf(Uint8Array);
    expect(gifHeaderOf(gif!)).toBe("GIF89a");
    expect(gif!.length).toBeGreaterThan(0);
  });

  it("encodes a single-frame input into a valid (non-animated) GIF", async () => {
    const gif = await encodeScrollGif([{ png: createSolidPng(10, 10, [1, 2, 3, 255]) }], 300);
    expect(gifHeaderOf(gif!)).toBe("GIF89a");
  });

  it("degrades to null when frames have mismatched dimensions (a decode/capture inconsistency)", async () => {
    const frames = [{ png: createSolidPng(20, 15, [255, 0, 0, 255]) }, { png: createSolidPng(30, 15, [0, 255, 0, 255]) }];
    await expect(encodeScrollGif(frames, 300)).resolves.toBeNull();
  });

  it("degrades to null when a frame isn't a valid PNG (never throws)", async () => {
    const frames = [{ png: createSolidPng(10, 10, [1, 2, 3, 255]) }, { png: new Uint8Array([1, 2, 3, 4, 5]) }];
    await expect(encodeScrollGif(frames, 300)).resolves.toBeNull();
  });
});
