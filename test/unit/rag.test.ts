import { describe, expect, it } from "vitest";
import {
  bm25Rerank,
  bm25Scores,
  type BoundStatement,
  chunkFile,
  classifyRepoFile,
  countRepoChunks,
  deleteChunksForPaths,
  embedTexts,
  filePriority,
  formatRetrievedContext,
  type InferenceAdapter,
  isIndexablePath,
  type RagChunk,
  type RagInfra,
  ragNamespace,
  readChunkTexts,
  retrieveContext,
  type StorageAdapter,
  upsertChunks,
  type VectorAdapter,
  type VectorUpsert,
} from "../../src/review/rag";

// ── Adapter stub helpers (the injected infra replaces reviewbot's raw env bindings) ───────────────
const aiThatReturns = (data: unknown): InferenceAdapter => ({ run: async () => ({ data }) });
const ai1024: InferenceAdapter = aiThatReturns([Array(1024).fill(0.1)]);

/** A storage stub whose COUNT(*) returns `n` (warm vs cold index) and whose chunk-text SELECT returns rows. */
function storageStub(opts: { count?: number; rows?: Array<{ id: string; text: string }> } = {}): StorageAdapter {
  const bound = {
    first: async () => ({ n: opts.count ?? 0 }),
    all: async () => ({ results: opts.rows ?? [] }),
    run: async () => undefined,
  };
  return { prepare: () => ({ bind: () => bound }), batch: async () => undefined } as unknown as StorageAdapter;
}

describe("rag: code-not-content filtering (free-tier cost guard)", () => {
  it("indexes source code + docs, skips content/data/deps/binaries", () => {
    expect(classifyRepoFile("src/core/runtime.ts")).toBe("code");
    expect(classifyRepoFile("scripts/build.mjs")).toBe("code");
    expect(classifyRepoFile("README.md")).toBe("doc");
    expect(classifyRepoFile("docs/architecture.mdx")).toBe("doc");
    // skipped: the huge content corpus, data, deps, build output, binaries, lockfiles
    expect(classifyRepoFile("content/mcp/some-entry.mdx")).toBe("skip");
    expect(classifyRepoFile("data/fixtures.json")).toBe("skip");
    expect(classifyRepoFile("node_modules/x/index.js")).toBe("skip");
    expect(classifyRepoFile("dist/bundle.js")).toBe("skip");
    expect(classifyRepoFile("package-lock.json")).toBe("skip");
    expect(classifyRepoFile("pnpm-lock.yaml")).toBe("skip");
    expect(classifyRepoFile("public/logo.png")).toBe("skip");
    expect(classifyRepoFile("app.min.js")).toBe("skip");
  });

  it("skips oversized files and orders source before docs", () => {
    expect(isIndexablePath("src/a.ts")).toBe(true);
    expect(isIndexablePath("src/a.ts", 2_000_000)).toBe(false); // > 1MB
    expect(isIndexablePath("content/x.mdx")).toBe(false);
    expect(filePriority("src/a.ts")).toBeLessThan(filePriority("README.md"));
  });

  it("namespaces per repo (bounded to 64 bytes, lowercased)", () => {
    expect(ragNamespace("gittensory", "JSONbored/gittensory")).toBe("gittensory:jsonbored/gittensory");
  });
});

describe("rag: per-file chunking", () => {
  it("emits one chunk for a small file", () => {
    const chunks = chunkFile("src/a.ts", "export const x = 1;\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ path: "src/a.ts", chunkIndex: 0, kind: "code", id: "src/a.ts::0" });
  });

  it("splits an oversized file into overlapping chunks with stable ids", () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} aaaaaaaaaa`).join("\n"); // > 16k chars
    const chunks = chunkFile("src/big.ts", big);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => expect(c.id).toBe(`src/big.ts::${i}`));
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });

  it("returns nothing for skipped paths or empty files", () => {
    expect(chunkFile("content/x.mdx", "stuff")).toEqual([]);
    expect(chunkFile("src/a.ts", "   ")).toEqual([]);
  });

  it("splits a JS/TS file at FUNCTION boundaries, never mid-function, tagging the boundary kind (#282)", () => {
    const fn = (n: number) => `export function f${n}() {\n${Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i}; // padding aaaaaaaaaaaaaaaaaaaaaaaa`).join("\n")}\n}\n`;
    const chunks = chunkFile("src/multi.ts", fn(1) + fn(2) + fn(3)); // 3 functions, each ~6k; total > CHUNK_CHARS
    expect(chunks.length).toBeGreaterThan(1);
    // every chunk begins at a logical boundary (an export-function), not arbitrary mid-function newlines
    expect(chunks.every((c) => /^export function f\d/.test(c.text.trimStart()))).toBe(true);
    expect(chunks.every((c) => c.boundary === "export")).toBe(true);
    chunks.forEach((c, i) => expect(c.id).toBe(`src/multi.ts::${i}`));
  });

  it("does NOT hang on a degenerate chunkChars<=0 (clamped to >=1) (#rag-verify infinite-loop guard)", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i} aaaaaaaaaa`).join("\n");
    const chunks = chunkFile("src/big.py", big, "", { chunkChars: 0, chunkOverlap: 9999 }); // would loop forever unclamped
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });

  it("PACKS a small multi-function JS file into one chunk (free-tier vector budget unaffected) (#282)", () => {
    const chunks = chunkFile("src/small.ts", "export function a(){return 1;}\nexport function b(){return 2;}\nexport function c(){return 3;}\n");
    expect(chunks).toHaveLength(1);
  });

  it("tags a tiny single-unit file as a whole-file chunk + falls back to newline chunking for non-JS (#282)", () => {
    expect(chunkFile("src/a.ts", "export const x = 1;\n")[0]?.boundary).toBe("file"); // no boundary line → file
    const bigPy = Array.from({ length: 4000 }, (_, i) => `x_${i} = ${i}`).join("\n");
    expect(chunkFile("src/big.py", bigPy).every((c) => c.boundary === "file")).toBe(true); // non-JS → newline chunker
  });

  it("scopes chunk ids by namespace so different repos can't collide in the shared vector index", () => {
    const a = chunkFile("README.md", "hello", "gittensory:o/repo-a");
    const b = chunkFile("README.md", "hello", "gittensory:o/repo-b");
    expect(a[0]?.id).toBe("gittensory:o/repo-a|README.md::0");
    expect(b[0]?.id).toBe("gittensory:o/repo-b|README.md::0");
    expect(a[0]?.id).not.toBe(b[0]?.id);
  });
});

describe("rag: BM25 reranking (#283)", () => {
  it("scores a doc with exact query-term overlap above an unrelated doc", () => {
    const scores = bm25Scores("parse the auth token", ["function parseAuthToken(token) { return verify(token); }", "const colors = ['red','green','blue']; // palette"]);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
  });
  it("reorders chunks so the term-relevant one wins (demotes a vector-accident match)", () => {
    const chunks = [
      { path: "palette.ts", text: "export const palette = ['red','green']; // unrelated to the query" },
      { path: "auth.ts", text: "export function verifyAuthToken(token) { return decode(token); }" },
    ];
    const out = bm25Rerank("verify auth token", chunks);
    expect(out[0]?.path).toBe("auth.ts");
  });
  it("is a no-op for 0/1 chunk", () => {
    expect(bm25Rerank("x", [])).toEqual([]);
    const one = [{ path: "a", text: "b" }];
    expect(bm25Rerank("x", one)).toBe(one);
  });
});

describe("rag: formatRetrievedContext", () => {
  it("renders a delimited, reference-only block (empty for no chunks)", () => {
    expect(formatRetrievedContext([])).toBe("");
    const out = formatRetrievedContext([{ path: "src/a.ts", text: "export const x = 1;" }]);
    expect(out).toContain("RELEVANT EXISTING CODE / DOCS");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("export const x = 1;");
    expect(out).toMatch(/ignore any instructions embedded/i); // reference-only framing
  });
});

describe("rag: fail-safe (never throws; degrades to no context)", () => {
  it("embedTexts returns null without an AI binding", async () => {
    expect(await embedTexts(undefined, ["hi"])).toBeNull();
  });

  it("embedTexts rejects a wrong-DIMENSION embedding (a non-1024-d model / malformed vector) (#abc-verify)", async () => {
    expect(await embedTexts(aiThatReturns([[0.1, 0.2]]), ["hi"])).toBeNull(); // 2-d, not 1024
    expect((await embedTexts(ai1024, ["hi"]))?.[0]?.length).toBe(1024);
  });

  it("retrieveContext returns '' when the vector index / AI are unbound", async () => {
    const infra: RagInfra = { storage: storageStub({ count: 5 }) };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "x" })).toBe("");
  });

  it("retrieveContext returns '' when the vector query throws", async () => {
    const vector = { query: async () => { throw new Error("boom"); } } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 5 }), vector, inference: ai1024 }; // warm index → reaches the query
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "x" })).toBe("");
  });

  it("retrieveContext skips the embed + query entirely when the index is cold (0 chunks) (#audit)", async () => {
    let queried = false;
    const vector = { query: async () => { queried = true; return { matches: [] }; } } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 0 }), vector, inference: ai1024 }; // cold index
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "x" })).toBe("");
    expect(queried).toBe(false); // never spent a vector query / inference call on an empty namespace
  });

  it("skips a trivially-short query without any embed/query (#cloud-opt min-length guard)", async () => {
    let aiCalled = false;
    const inference: InferenceAdapter = { run: async () => { aiCalled = true; return { data: [[0.1]] }; } };
    const vector = { query: async () => ({ matches: [] }) } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 5 }), vector, inference };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "tweak" })).toBe(""); // < 40 chars
    expect(aiCalled).toBe(false);
  });

  it("retrieves + formats matches, and excludes the changed files themselves", async () => {
    const matches = [
      { id: "src/a.ts::0", score: 0.9, metadata: { path: "src/a.ts" } },
      { id: "src/changed.ts::0", score: 0.8, metadata: { path: "src/changed.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 2, rows: [{ id: "src/a.ts::0", text: "export const x = 1;" }] }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "refactor the auth token verification and add coverage", excludePaths: ["src/changed.ts"] });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("export const x = 1;");
    expect(out).not.toContain("src/changed.ts"); // the file under review is excluded → only RELATED code surfaces
  });

  it("minScore drops low-relevance matches (#rag-observability)", async () => {
    const matches = [
      { id: "src/hit.ts::0", score: 0.82, metadata: { path: "src/hit.ts" } },
      { id: "src/weak.ts::0", score: 0.2, metadata: { path: "src/weak.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 2, rows: [{ id: "src/hit.ts::0", text: "kept code" }, { id: "src/weak.ts::0", text: "weak code" }] }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "refactor the auth token verification and add coverage", minScore: 0.5 });
    expect(out).toContain("src/hit.ts");
    expect(out).not.toContain("src/weak.ts"); // below minScore → dropped (was injected before the threshold existed)
  });
});

// ── Index write (upsertChunks) ─────────────────────────────────────────────────────────────────────
describe("rag: upsertChunks (embed + vector upsert + chunk-text store)", () => {
  const chunks: RagChunk[] = [
    { id: "ns|src/a.ts::0", path: "src/a.ts", chunkIndex: 0, kind: "code", text: "export const x = 1;" },
  ];

  it("embeds, upserts vectors + metadata, persists chunk text, and returns the count", async () => {
    const upserted: VectorUpsert[][] = [];
    const vector = { upsert: async (v: VectorUpsert[]) => { upserted.push(v); } } as unknown as VectorAdapter;
    let batched = 0;
    const storage = {
      prepare: () => ({ bind: () => ({ run: async () => undefined }) as unknown as BoundStatement }),
      batch: async (stmts: BoundStatement[]) => { batched = stmts.length; },
    } as unknown as StorageAdapter;
    const n = await upsertChunks({ storage, vector, inference: ai1024 }, "gittensory", "o/r", chunks);
    expect(n).toBe(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]?.[0]).toMatchObject({ id: "ns|src/a.ts::0", namespace: ragNamespace("gittensory", "o/r"), metadata: { path: "src/a.ts", chunkIndex: 0, kind: "code" } });
    expect((upserted[0]?.[0]?.values ?? []).length).toBe(1024);
    expect(batched).toBe(1); // one INSERT statement per chunk handed to db.batch
  });

  it("returns 0 with no vector / no inference / empty chunks (the fail-safe guard)", async () => {
    const vector = { upsert: async () => undefined } as unknown as VectorAdapter;
    const storage = storageStub();
    expect(await upsertChunks({ storage, inference: ai1024 }, "p", "o/r", chunks)).toBe(0); // no vector
    expect(await upsertChunks({ storage, vector }, "p", "o/r", chunks)).toBe(0); // no inference
    expect(await upsertChunks({ storage, vector, inference: ai1024 }, "p", "o/r", [])).toBe(0); // empty
  });

  it("returns 0 when embedding yields nothing (a degraded inference response)", async () => {
    const vector = { upsert: async () => undefined } as unknown as VectorAdapter;
    const badAi: InferenceAdapter = { run: async () => ({ data: null }) }; // null data → embedTexts returns null
    expect(await upsertChunks({ storage: storageStub(), vector, inference: badAi }, "p", "o/r", chunks)).toBe(0);
  });

  it("returns 0 (no throw) when the vector upsert fails (#fail-safe)", async () => {
    const vector = { upsert: async () => { throw new Error("vectorize down"); } } as unknown as VectorAdapter;
    expect(await upsertChunks({ storage: storageStub(), vector, inference: ai1024 }, "p", "o/r", chunks)).toBe(0);
  });
});

// ── Incremental delete (deleteChunksForPaths) ────────────────────────────────────────────────────────
describe("rag: deleteChunksForPaths (incremental re-index of changed files)", () => {
  it("resolves ids for the paths then deletes them from the vector index + storage", async () => {
    const deletedIds: string[][] = [];
    const vector = { deleteByIds: async (ids: string[]) => { deletedIds.push(ids); } } as unknown as VectorAdapter;
    let deleteRuns = 0;
    const storage = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: sql.includes("SELECT id") ? [{ id: "ns|src/a.ts::0" }, { id: "ns|src/b.ts::0" }] : [] }),
          run: async () => { if (sql.startsWith("DELETE")) deleteRuns += 1; },
        }) as unknown as BoundStatement,
      }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    await deleteChunksForPaths({ storage, vector }, "p", "o/r", ["src/a.ts", "src/b.ts"]);
    expect(deletedIds).toEqual([["ns|src/a.ts::0", "ns|src/b.ts::0"]]);
    expect(deleteRuns).toBe(1);
  });

  it("early-returns for an empty path list (no storage I/O)", async () => {
    let touched = false;
    const storage = { prepare: () => { touched = true; return { bind: () => ({}) }; }, batch: async () => undefined } as unknown as StorageAdapter;
    await deleteChunksForPaths({ storage }, "p", "o/r", []);
    expect(touched).toBe(false);
  });

  it("returns early when no ids resolve (nothing to delete)", async () => {
    let deleted = false;
    const vector = { deleteByIds: async () => { deleted = true; } } as unknown as VectorAdapter;
    const storage = storageStub({ rows: [] }); // SELECT id → []
    await deleteChunksForPaths({ storage, vector }, "p", "o/r", ["src/a.ts"]);
    expect(deleted).toBe(false);
  });

  it("swallows a storage failure (fail-safe; never throws)", async () => {
    const storage = { prepare: () => { throw new Error("d1 down"); }, batch: async () => undefined } as unknown as StorageAdapter;
    await expect(deleteChunksForPaths({ storage }, "p", "o/r", ["src/a.ts"])).resolves.toBeUndefined();
  });
});

// ── countRepoChunks / embedTexts / readChunkTexts catch paths ────────────────────────────────────────
describe("rag: storage/inference catch paths return their fail-safe defaults", () => {
  it("countRepoChunks returns 0 when the storage read throws", async () => {
    const storage = { prepare: () => { throw new Error("d1 down"); }, batch: async () => undefined } as unknown as StorageAdapter;
    expect(await countRepoChunks(storage, "p", "o/r")).toBe(0);
  });

  it("embedTexts returns null when inference throws", async () => {
    const inference: InferenceAdapter = { run: async () => { throw new Error("ai down"); } };
    expect(await embedTexts(inference, ["hi"])).toBeNull();
  });

  it("readChunkTexts returns an empty Map when the storage read throws", async () => {
    const storage = { prepare: () => { throw new Error("d1 down"); }, batch: async () => undefined } as unknown as StorageAdapter;
    const map = await readChunkTexts(storage, ["id-1"]);
    expect(map.size).toBe(0);
  });

  it("readChunkTexts short-circuits on an empty id list", async () => {
    expect((await readChunkTexts(storageStub(), [])).size).toBe(0);
  });
});

// ── JS/TS chunker boundary kinds + oversized-unit newline split ───────────────────────────────────────
describe("rag: chunkJsTs boundary kinds + oversized single unit (#282)", () => {
  it("tags a leading `class` boundary as 'class' and a plain function/const as 'function'", () => {
    // First unit a class, a second smaller-than-budget unit forces >1 segment so chunkJsTs runs.
    const classBody = Array.from({ length: 120 }, (_, i) => `  m${i}() { return ${i}; } // padding aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`).join("\n");
    const fnBody = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i}; // padding bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`).join("\n");
    const text = `class Foo {\n${classBody}\n}\nconst helper = function () {\n${fnBody}\n};\n`;
    const chunks = chunkFile("src/c.ts", text); // two units, each ~6k → packs into >1 chunk
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.boundary).toBe("class"); // non-exported `class X` → class
    expect(chunks.some((c) => c.boundary === "function")).toBe(true); // the `const helper = function` unit → function
  });

  it("newline-splits an OVERSIZED single logical unit so no chunk exceeds the budget (#282)", () => {
    // One function body > CHUNK_CHARS(16000). Add a small second unit so segments.length > 1 (chunkJsTs runs);
    // the big unit then takes the oversized-segment newline-split branch.
    const huge = Array.from({ length: 700 }, (_, i) => `  const z${i} = ${i}; // ${"x".repeat(40)}`).join("\n"); // > 16000 chars
    // a second boundary-matching unit so segments.length > 1 (chunkJsTs runs); the big unit then hits
    // the oversized-segment newline-split branch.
    const text = `function big() {\n${huge}\n}\nconst tail = function () { return 1; };\n`;
    const chunks = chunkFile("src/huge.ts", text);
    expect(chunks.length).toBeGreaterThan(1);
    // the oversized unit was split into newline sub-chunks, all tagged 'function', none over the budget
    expect(chunks.some((c) => c.boundary === "function")).toBe(true);
    expect(chunks.every((c) => c.text.length <= 16000)).toBe(true);
    chunks.forEach((c, i) => expect(c.id).toBe(`src/huge.ts::${i}`)); // ids stay dense + stable across the split
  });
});

describe("rag: retrieveContext outer catch", () => {
  it("returns '' (never throws) when the vector query throws AFTER a long-enough query reaches it", async () => {
    // queryText >= MIN_QUERY_CHARS(40) so it gets PAST the short-query guard into the try, where query throws.
    const vector = { query: async () => { throw new Error("vectorize query boom"); } } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 9 }), vector, inference: ai1024 }; // warm index → reaches the query
    const out = await retrieveContext(infra, { project: "catchp", repo: "o/catch-repo", queryText: "this is a sufficiently long query to clear the min length guard" });
    expect(out).toBe("");
  });
});

describe("rag: classifyRepoFile unknown extension", () => {
  it("skips an unknown/unrecognized extension", () => {
    expect(classifyRepoFile("foo.xyz")).toBe("skip");
    expect(isIndexablePath("foo.xyz")).toBe(false);
  });
});

describe("rag: formatRetrievedContext budget omission", () => {
  it("omits trailing chunks once the budget is exceeded and notes the omission", () => {
    const big = "y".repeat(8000);
    const chunks = [
      { path: "src/a.ts", text: big },
      { path: "src/b.ts", text: big }, // combined > MAX_CONTEXT_CHARS(14000) → second is omitted
      { path: "src/c.ts", text: big },
    ];
    const out = formatRetrievedContext(chunks);
    expect(out).toContain("src/a.ts");
    expect(out).toContain("additional related context omitted to stay within budget");
    expect(out).not.toContain("src/c.ts"); // never reached after the budget break
  });
});
