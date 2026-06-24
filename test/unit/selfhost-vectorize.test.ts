import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { cosineSimilarity, createSqliteVectorize } from "../../src/selfhost/vectorize";

function makeVectorize(): ReturnType<typeof createSqliteVectorize> {
  return createSqliteVectorize(nodeSqliteDriver(new DatabaseSync(":memory:") as never));
}

describe("cosineSimilarity", () => {
  it("is 1 for identical and 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0); // zero-norm guard
  });
});

describe("createSqliteVectorize (#979 local RAG)", () => {
  it("returns the nearest-by-cosine match within a namespace, with metadata + topK", async () => {
    const v = makeVectorize();
    await v.upsert([
      { id: "a", values: [1, 0, 0], namespace: "repo1", metadata: { path: "a.ts" } },
      { id: "b", values: [0, 1, 0], namespace: "repo1", metadata: { path: "b.ts" } },
    ]);
    const res = await v.query([0.9, 0.1, 0], { topK: 1, namespace: "repo1", returnMetadata: "all" });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.id).toBe("a");
    expect(res.matches[0]?.metadata?.path).toBe("a.ts");
  });

  it("scopes results by namespace", async () => {
    const v = makeVectorize();
    await v.upsert([
      { id: "x", values: [1, 0], namespace: "n1" },
      { id: "y", values: [1, 0], namespace: "n2" },
    ]);
    const res = await v.query([1, 0], { topK: 10, namespace: "n1" });
    expect(res.matches.map((m) => m.id)).toEqual(["x"]);
  });

  it("upsert overwrites by id; deleteByIds removes", async () => {
    const v = makeVectorize();
    await v.upsert([{ id: "d", values: [1, 0], namespace: "n", metadata: { path: "old" } }]);
    await v.upsert([{ id: "d", values: [0, 1], namespace: "n", metadata: { path: "new" } }]); // overwrite
    let res = await v.query([0, 1], { topK: 10, namespace: "n" });
    expect(res.matches[0]?.metadata?.path).toBe("new");
    await v.deleteByIds(["d"]);
    res = await v.query([0, 1], { topK: 10, namespace: "n" });
    expect(res.matches).toHaveLength(0);
  });
});
