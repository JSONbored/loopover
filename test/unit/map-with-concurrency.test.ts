import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../src/queue/map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("passes each mapper the stable item index with concurrent workers", async () => {
    const seenByItem: number[] = [];

    const result = await mapWithConcurrency(["a", "b", "c", "d"], 3, async (item, index) => {
      seenByItem[index] = index;
      await Promise.resolve();
      return `${index}:${item}`;
    });

    expect(seenByItem).toEqual([0, 1, 2, 3]);
    expect(result).toEqual(["0:a", "1:b", "2:c", "3:d"]);
  });

  it("keeps one-argument mappers source-compatible", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 2, async (item) => item * 2);

    expect(result).toEqual([2, 4, 6]);
  });
});
