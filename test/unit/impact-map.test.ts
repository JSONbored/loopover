import { describe, expect, it } from "vitest";
import { computeImpactMap, MAX_AFFECTED_MODULES_PER_ENTRY, MAX_IMPACT_MAP_INPUT_FILES } from "../../src/review/impact-map";
import type { FileChangedSymbols } from "../../src/review/impact-symbols";
import type { InferenceAdapter, RagInfra, StorageAdapter, VectorAdapter } from "../../src/review/rag";

const ai1024: InferenceAdapter = { run: async () => ({ data: [Array(1024).fill(0.1)] }) };

/** A bare storage stub: COUNT(*) returns `n` (warm vs cold index); the chunk-text SELECT always answers empty.
 *  Fine for cold-index / no-adapter / no-match cases, where no chunk text is ever read. */
function storageStub(count: number): StorageAdapter {
  const bound = { first: async () => ({ n: count }), all: async () => ({ results: [] }), run: async () => undefined };
  return { prepare: () => ({ bind: () => bound }), batch: async () => undefined } as unknown as StorageAdapter;
}

/** A storage stub whose chunk-text SELECT answers with a placeholder body for every requested id.
 *  `retrieveContextWithMetrics` drops any match with no stored chunk text (`chunks.filter((c) => c.text)` in
 *  rag.ts), so any test expecting a vector match to actually SURVIVE into `metrics.paths` needs this — even
 *  though `computeImpactMap` itself only reads `metrics.paths`, never the formatted context text. */
function storageStubWithText(count: number): StorageAdapter {
  return {
    prepare: (sql: string) => ({
      bind: (...ids: unknown[]) => ({
        first: async () => ({ n: count }),
        all: async () =>
          /SELECT id, text/i.test(sql) ? { results: ids.map((id) => ({ id: String(id), text: `body for ${String(id)}` })) } : { results: [] },
        run: async () => undefined,
      }),
    }),
    batch: async () => undefined,
  } as unknown as StorageAdapter;
}

function vectorStub(matches: Array<{ id: string; score: number; metadata: { path: string } }>): VectorAdapter {
  return {
    query: async () => ({ matches }),
    upsert: async () => undefined,
    deleteByIds: async () => undefined,
  } as unknown as VectorAdapter;
}

describe("computeImpactMap", () => {
  it("returns one entry per changed file with a matched neighbour (single-caller)", async () => {
    const infra: RagInfra = {
      storage: storageStubWithText(5),
      vector: vectorStub([{ id: "src/review/caller.ts::0", score: 0.9, metadata: { path: "src/review/caller.ts" } }]),
      inference: ai1024,
    };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(result).toEqual([
      { changedModule: "src/review/impact-map.ts", affectedModules: ["src/review/caller.ts"], callers: ["computeImpactMap"] },
    ]);
  });

  it("surfaces multiple affected modules for one changed file (multi-caller), capped and ordered", async () => {
    const matches = Array.from({ length: MAX_AFFECTED_MODULES_PER_ENTRY + 5 }, (_, i) => ({
      id: `src/review/caller${i}.ts::0`,
      score: 0.9 - i * 0.01,
      metadata: { path: `src/review/caller${i}.ts` },
    }));
    const infra: RagInfra = { storage: storageStubWithText(5), vector: vectorStub(matches), inference: ai1024 };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(result).toHaveLength(1);
    expect(result[0]?.affectedModules).toHaveLength(MAX_AFFECTED_MODULES_PER_ENTRY);
    // Deterministic ordering: the highest-scoring match leads (RAG's own retrieval order).
    expect(result[0]?.affectedModules[0]).toBe("src/review/caller0.ts");
  });

  it("REGRESSION (Superagent P2): caps RAG queries at MAX_IMPACT_MAP_INPUT_FILES regardless of how many changed files carry symbols", async () => {
    let queryCount = 0;
    const countingVector: VectorAdapter = {
      query: async () => {
        queryCount += 1;
        return { matches: [{ id: "src/review/caller.ts::0", score: 0.9, metadata: { path: "src/review/caller.ts" } }] };
      },
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStubWithText(5), vector: countingVector, inference: ai1024 };
    // A PR touching far more symbol-bearing files than the cap -- e.g. an attacker-controlled diff with
    // hundreds of changed files, each contributing at least one extracted symbol.
    const symbols: FileChangedSymbols[] = Array.from({ length: MAX_IMPACT_MAP_INPUT_FILES + 25 }, (_, i) => ({
      path: `src/review/module${i}.ts`,
      symbols: [`fn${i}`],
    }));
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(queryCount).toBe(MAX_IMPACT_MAP_INPUT_FILES);
    expect(result).toHaveLength(MAX_IMPACT_MAP_INPUT_FILES);
    // Deterministic: the FIRST N input files are kept, not a sample.
    expect(result[0]?.changedModule).toBe("src/review/module0.ts");
    expect(result.at(-1)?.changedModule).toBe(`src/review/module${MAX_IMPACT_MAP_INPUT_FILES - 1}.ts`);
  });

  it("does not count a symbol-less file against the query cap", async () => {
    let queryCount = 0;
    const countingVector: VectorAdapter = {
      query: async () => {
        queryCount += 1;
        return { matches: [{ id: "src/review/caller.ts::0", score: 0.9, metadata: { path: "src/review/caller.ts" } }] };
      },
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStubWithText(5), vector: countingVector, inference: ai1024 };
    // MAX_IMPACT_MAP_INPUT_FILES symbol-bearing files, interleaved with symbol-less ones that must not
    // consume any of the query budget.
    const symbols: FileChangedSymbols[] = Array.from({ length: MAX_IMPACT_MAP_INPUT_FILES }, (_, i) => ({
      path: `src/review/module${i}.ts`,
      symbols: [`fn${i}`],
    }));
    symbols.splice(1, 0, { path: "README.md", symbols: [] }, { path: "docs/guide.md", symbols: [] });
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(queryCount).toBe(MAX_IMPACT_MAP_INPUT_FILES);
    expect(result).toHaveLength(MAX_IMPACT_MAP_INPUT_FILES);
  });

  it("produces no entry for a changed file whose own module is the only RAG match (self-only, excluded)", async () => {
    // The vector adapter would return the changed file itself as a match, but retrieveContextWithMetrics
    // excludes it via excludePaths — so the affected-modules set is empty and no entry is produced.
    const infra: RagInfra = {
      storage: storageStubWithText(5),
      vector: vectorStub([{ id: "src/review/impact-map.ts::0", score: 0.9, metadata: { path: "src/review/impact-map.ts" } }]),
      inference: ai1024,
    };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(result).toEqual([]);
  });

  it("produces no entry for a changed file with zero extracted symbols (nothing to query on)", async () => {
    const infra: RagInfra = {
      storage: storageStubWithText(5),
      vector: vectorStub([{ id: "src/review/caller.ts::0", score: 0.9, metadata: { path: "src/review/caller.ts" } }]),
      inference: ai1024,
    };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: [] }];
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(result).toEqual([]);
  });

  it("produces no entry when the composed query is too short to retrieve on (short path, no symbols to lengthen it)", async () => {
    // A short path + a short symbol name can compose a query under RAG's own MIN_QUERY_CHARS floor — this must
    // degrade to "no entry", not throw, and must never reach the vector adapter (mirrors rag.ts's own
    // short-query guard test).
    let queried = false;
    const vector = {
      query: async () => {
        queried = true;
        return { matches: [] };
      },
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub(5), vector, inference: ai1024 };
    const symbols: FileChangedSymbols[] = [{ path: "a.ts", symbols: ["a"] }];
    expect(await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" })).toEqual([]);
    expect(queried).toBe(false);
  });

  it("returns an empty impact map for an empty symbol list", async () => {
    const infra: RagInfra = { storage: storageStub(5), vector: vectorStub([]), inference: ai1024 };
    expect(await computeImpactMap([], { infra, project: "acme", repo: "widgets" })).toEqual([]);
  });

  it("returns an empty impact map when the RAG index is cold (empty-index, fail-safe)", async () => {
    const infra: RagInfra = {
      storage: storageStub(0),
      vector: vectorStub([{ id: "src/review/x.ts::0", score: 1, metadata: { path: "src/review/x.ts" } }]),
      inference: ai1024,
    };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    expect(await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" })).toEqual([]);
  });

  it("returns an empty impact map when no vector/inference adapter is configured (RAG unavailable)", async () => {
    const infra: RagInfra = { storage: storageStub(5) };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    expect(await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" })).toEqual([]);
  });

  it("degrades a single file's entry to no-affected-modules when the vector query throws (fail-safe, never blocks the rest)", async () => {
    const throwingVector = {
      query: async () => {
        throw new Error("boom");
      },
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub(5), vector: throwingVector, inference: ai1024 };
    const symbols: FileChangedSymbols[] = [{ path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] }];
    expect(await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" })).toEqual([]);
  });

  it("computes independent entries for multiple changed files in input order", async () => {
    let call = 0;
    const vector: VectorAdapter = {
      query: async () => {
        call += 1;
        return call === 1
          ? { matches: [{ id: "src/review/x.ts::0", score: 0.9, metadata: { path: "src/review/x.ts" } }] }
          : { matches: [{ id: "src/review/y.ts::0", score: 0.9, metadata: { path: "src/review/y.ts" } }] };
      },
      upsert: async () => undefined,
      deleteByIds: async () => undefined,
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStubWithText(5), vector, inference: ai1024 };
    const symbols: FileChangedSymbols[] = [
      { path: "src/review/impact-symbols.ts", symbols: ["extractChangedSymbols"] },
      { path: "src/review/impact-map.ts", symbols: ["computeImpactMap"] },
    ];
    const result = await computeImpactMap(symbols, { infra, project: "acme", repo: "widgets" });
    expect(result).toEqual([
      { changedModule: "src/review/impact-symbols.ts", affectedModules: ["src/review/x.ts"], callers: ["extractChangedSymbols"] },
      { changedModule: "src/review/impact-map.ts", affectedModules: ["src/review/y.ts"], callers: ["computeImpactMap"] },
    ]);
  });
});
