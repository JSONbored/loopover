// Shared contract test for the self-host Vectorize-shaped RAG store pair (#4010): runs the IDENTICAL
// assertion suite against createSqliteVectorize, createQdrantVectorize, and createPgVectorize via
// describe.each, so a future change that breaks parity between the three -- despite all three still
// satisfying SelfHostVectorize structurally -- is caught here instead of discovered later as a silent
// production divergence. Also directly exercises the returnMetadata fix (#4010): all three backends now
// accept `returnMetadata` on their QueryOptions (see backend-contracts.ts's SelfHostVectorizeQueryOptions doc
// comment for why), and this suite calls every one of them with it set, matching how
// src/review/adapters.ts's reviewVectorAdapter always calls whichever backend is bound to env.VECTORIZE.
//
// Postgres and Qdrant are backed by lightweight mocks (a scripted `pg.Pool` / a stubbed global `fetch`),
// matching the existing per-backend test files' own conventions (selfhost-pg-vectorize.test.ts,
// selfhost-qdrant-vectorize.test.ts) -- this suite is not a replacement for either backend's own richer
// implementation-specific tests, only the narrow, identical-inputs slice all three must agree on.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { nodeSqliteDriver } from "../../src/selfhost/d1-adapter";
import { createSqliteVectorize } from "../../src/selfhost/vectorize";
import { createQdrantVectorize } from "../../src/selfhost/qdrant-vectorize";
import { createPgVectorize } from "../../src/selfhost/pg-vectorize";
import type { SelfHostVectorize } from "../../src/selfhost/backend-contracts";

const QDRANT_BASE = "http://qdrant:6333";

/** One seeded vector record + the metadata a matching backend should surface for it. */
const SEED = { id: "seed-1", values: [1, 0], namespace: "contract-ns", metadata: { path: "seed.ts" } };

/** Build a fake fetch that returns the given JSON body for any call (mirrors
 *  selfhost-qdrant-vectorize.test.ts's own mockFetch helper). */
function mockFetch(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

/** A scripted `pg.Pool` that returns the given rows for ANY query (mirrors
 *  selfhost-pg-vectorize.test.ts's own makePool helper). */
function makePgPool(rows: Record<string, unknown>[]): Pool {
  return { async query() { return { rows, rowCount: rows.length }; } } as unknown as Pool;
}

const backends: Array<{
  name: string;
  makeEmpty: () => SelfHostVectorize;
  /** A backend pre-seeded so a query in SEED.namespace returns exactly one match for SEED. */
  makeWithSeedMatch: () => SelfHostVectorize;
}> = [
  {
    name: "sqlite",
    makeEmpty: () => createSqliteVectorize(nodeSqliteDriver(new DatabaseSync(":memory:") as never)) as unknown as SelfHostVectorize,
    makeWithSeedMatch: () => {
      const v = createSqliteVectorize(nodeSqliteDriver(new DatabaseSync(":memory:") as never)) as unknown as SelfHostVectorize;
      void v.upsert([SEED]);
      return v;
    },
  },
  {
    name: "postgres",
    makeEmpty: () => createPgVectorize(makePgPool([])) as unknown as SelfHostVectorize,
    makeWithSeedMatch: () =>
      createPgVectorize(makePgPool([{ id: SEED.id, score: 1, metadata: SEED.metadata }])) as unknown as SelfHostVectorize,
  },
  {
    name: "qdrant",
    makeEmpty: () => {
      vi.stubGlobal("fetch", mockFetch({ result: [] }));
      return createQdrantVectorize(QDRANT_BASE) as unknown as SelfHostVectorize;
    },
    makeWithSeedMatch: () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          result: [{ id: "qdrant-point-uuid", score: 1, payload: { _orig_id: SEED.id, namespace: SEED.namespace, ...SEED.metadata } }],
        }),
      );
      return createQdrantVectorize(QDRANT_BASE) as unknown as SelfHostVectorize;
    },
  },
];

describe.each(backends)("SelfHostVectorize contract ($name, #4010)", ({ makeEmpty, makeWithSeedMatch }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("upsert() returns a count and ids matching the input length", async () => {
    const v = makeEmpty();
    const result = await v.upsert([SEED, { ...SEED, id: "seed-2" }]);
    expect(result.count).toBe(2);
    expect(result.ids).toEqual([SEED.id, "seed-2"]);
  });

  it("query() against an empty store returns no matches", async () => {
    const v = makeEmpty();
    const { matches } = await v.query([1, 0], { topK: 5, namespace: SEED.namespace });
    expect(matches).toEqual([]);
  });

  it("query() with returnMetadata set finds the seeded match and surfaces its metadata", async () => {
    const v = makeWithSeedMatch();
    const { matches } = await v.query([1, 0], { topK: 5, namespace: SEED.namespace, returnMetadata: "all" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(SEED.id);
    expect(matches[0]?.metadata?.path).toBe("seed.ts");
  });

  it("query() accepts returnMetadata: none/indexed without throwing", async () => {
    const v = makeWithSeedMatch();
    await expect(v.query([1, 0], { topK: 5, namespace: SEED.namespace, returnMetadata: "none" })).resolves.toBeDefined();
    await expect(v.query([1, 0], { topK: 5, namespace: SEED.namespace, returnMetadata: "indexed" })).resolves.toBeDefined();
  });

  it("deleteByIds([]) is a no-op that resolves to count 0", async () => {
    const v = makeEmpty();
    expect(await v.deleteByIds([])).toEqual({ count: 0 });
  });
});
