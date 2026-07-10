import { describe, expect, it } from "vitest";
import { downscaleForVision } from "../../src/review/visual/image-downscale";

describe("image-downscale Worker-safe default (#4370)", () => {
  it("returns the input bytes unchanged, since the real implementation is self-host only", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await expect(downscaleForVision(png)).resolves.toBe(png);
  });

  it("returns an empty input unchanged", async () => {
    const empty = new Uint8Array([]);
    await expect(downscaleForVision(empty)).resolves.toBe(empty);
  });
});
