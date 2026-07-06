import { describe, expect, it } from "vitest";
import { encodeScrollGif, isScrollGifAvailable } from "../../src/review/visual/scroll-gif";

describe("scroll-gif Worker-safe default (#3612)", () => {
  it("reports scroll-GIF assembly as unavailable", () => {
    expect(isScrollGifAvailable()).toBe(false);
  });

  it("always resolves to null regardless of input, since the real implementation is self-host only", async () => {
    const frames = [{ png: new Uint8Array([1, 2, 3]) }, { png: new Uint8Array([4, 5, 6]) }];
    await expect(encodeScrollGif(frames, 500)).resolves.toBeNull();
    await expect(encodeScrollGif([], 500)).resolves.toBeNull();
  });
});
