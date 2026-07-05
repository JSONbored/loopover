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
  RAG_DIMENSIONS,
  ragDimensionsFromEnv,
  ragNamespace,
  readChunkTexts,
  retrieveContext,
  retrieveContextWithMetrics,
  type StorageAdapter,
  upsertChunks,
  type VectorAdapter,
  type VectorUpsert,
} from "../../src/review/rag";

// ── Adapter stub helpers (the injected infra replaces reviewbot's raw env bindings) ───────────────
const aiThatReturns = (data: unknown): InferenceAdapter => ({ run: async () => ({ data }) });
const ai1024: InferenceAdapter = aiThatReturns([Array(1024).fill(0.1)]);
const ai768: InferenceAdapter = aiThatReturns([Array(768).fill(0.1)]);

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
    // TypeScript module extensions (parity with signals/local-branch isCodeFile)
    expect(classifyRepoFile("src/loader.mts")).toBe("code");
    expect(classifyRepoFile("src/setup.cts")).toBe("code");
    expect(filePriority("src/loader.mts")).toBe(0);
    expect(isIndexablePath("src/setup.cts")).toBe(true);
    // additional source languages (parity with the changed-file source classifiers)
    for (const p of [
      "lib/widget.dart",
      "scripts/hook.lua",
      "lib/app.ex",
      "test/app_test.exs",
      "src/core.clj",
      "web/app.cljs",
      "src/Main.hs",
      "analysis/model.jl",
      "src/server.nim",
      "src/fast.zig",
      "pipeline/Jenkinsfile.groovy",
    ]) {
      expect(classifyRepoFile(p)).toBe("code");
    }
    // Go's extensionless dependency manifests (go.mod/go.work) are real, high-value source — same
    // extensionless-allowlist treatment as Dockerfile/Makefile. Their resolved-tree lockfile
    // siblings (go.sum/go.work.sum) stay excluded via SKIP_FILE_RE below.
    expect(classifyRepoFile("go.mod")).toBe("code");
    expect(classifyRepoFile("go.work")).toBe("code");
    expect(classifyRepoFile("nested/module/go.mod")).toBe("code");
    expect(classifyRepoFile("README.md")).toBe("doc");
    expect(classifyRepoFile("docs/architecture.mdx")).toBe("doc");
    // long-form doc spellings (parity with signals/path-matchers DOCS_EXTENSIONS)
    expect(classifyRepoFile("NOTES.markdown")).toBe("doc");
    expect(classifyRepoFile("docs/guide.asciidoc")).toBe("doc");
    // skipped: the huge content corpus, data, deps, build output, binaries, lockfiles
    expect(classifyRepoFile("content/mcp/some-entry.mdx")).toBe("skip");
    expect(classifyRepoFile("data/fixtures.json")).toBe("skip");
    expect(classifyRepoFile("node_modules/x/index.js")).toBe("skip");
    expect(classifyRepoFile("dist/bundle.js")).toBe("skip");
    expect(classifyRepoFile("package-lock.json")).toBe("skip");
    expect(classifyRepoFile("pnpm-lock.yaml")).toBe("skip");
    // go.sum stays skipped despite go.mod/go.work now being recognized — SKIP_FILE_RE's lockfile
    // check runs before ALLOW_EXTLESS_RE, so the resolved-tree lockfile never becomes indexable.
    expect(classifyRepoFile("go.sum")).toBe("skip");
    expect(classifyRepoFile("public/logo.png")).toBe("skip");
    expect(classifyRepoFile("app.min.js")).toBe("skip");
    // more binary blobs: media/archives/fonts/compiled artifacts and ML model weights
    for (const p of [
      "assets/photo.bmp",
      "assets/scan.tiff",
      "media/clip.webm",
      "audio/track.flac",
      "release/app.7z",
      "release/pkg.zst",
      "fonts/Inter.otf",
      "build/App.class",
      "lib/app.jar",
      "cache/mod.pyc",
      "db/local.sqlite",
      "models/qwen3.gguf",
      "models/weights.safetensors",
      "checkpoints/model.ckpt",
      "data/embeddings.npy",
    ]) {
      expect(classifyRepoFile(p)).toBe("skip");
    }
  });

  it("skips more build/cache/dependency output directories", () => {
    for (const p of [
      "target/release/app.rs",
      ".venv/lib/site.py",
      "venv/bin/thing.py",
      "src/__pycache__/mod.cpython-312.pyc",
      ".mypy_cache/3.12/foo.data.json",
      ".pytest_cache/v/cache/lastfailed",
      ".tox/py312/log.txt",
      "web/.svelte-kit/generated/root.svelte",
      "app/.nuxt/app.config.mjs",
      ".gradle/caches/x.bin",
      "backend/_build/dev/lib/app.beam",
      "infra/.terraform/providers/plugin.go",
    ]) {
      expect(classifyRepoFile(p)).toBe("skip");
    }
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

describe("ragDimensionsFromEnv", () => {
  it("uses a positive integer dimension from configuration", () => {
    expect(ragDimensionsFromEnv("768")).toBe(768);
    expect(ragDimensionsFromEnv("1536.9")).toBe(1536);
  });

  it("falls back to the bge-m3 default for unset, invalid, or non-positive values", () => {
    expect(ragDimensionsFromEnv(undefined)).toBe(RAG_DIMENSIONS);
    expect(ragDimensionsFromEnv("")).toBe(RAG_DIMENSIONS);
    expect(ragDimensionsFromEnv("not-a-number")).toBe(RAG_DIMENSIONS);
    expect(ragDimensionsFromEnv("0")).toBe(RAG_DIMENSIONS);
    expect(ragDimensionsFromEnv("-5")).toBe(RAG_DIMENSIONS);
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

  it("embedTexts accepts a configured 768-dimension embedder without weakening the default guard", async () => {
    expect(await embedTexts(ai768, ["hi"])).toBeNull();
    expect((await embedTexts(ai768, ["hi"], 768))?.[0]?.length).toBe(768);
  });

  it("retrieveContext returns '' when the vector index / AI are unbound", async () => {
    const infra: RagInfra = { storage: storageStub({ count: 5 }) };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "x" })).toBe("");
  });

  it("retrieveContextWithMetrics returns empty metrics when retrieval is skipped", async () => {
    const infra: RagInfra = { storage: storageStub({ count: 5 }) };
    await expect(
      retrieveContextWithMetrics(infra, {
        project: "p",
        repo: "o/r",
        queryText: "refactor the auth token verification and add coverage",
        minScore: 0.7,
      }),
    ).resolves.toEqual({
      context: "",
      metrics: {
        candidates: 0,
        kept: 0,
        topScore: 0,
        minScore: 0.7,
        reranked: false,
        injectedChars: 0,
        paths: [],
      },
    });
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

  it("returns '' via the COLD-INDEX guard for a LONG query against an empty namespace (the hasIndexedChunks=false return)", async () => {
    // A query >= MIN_QUERY_CHARS so it clears the short-query guard and reaches `if (!(await hasIndexedChunks(...)))`.
    // A unique project/repo (never warmed by another test) guarantees the module-level positive cache has no entry,
    // so hasIndexedChunks does the real COUNT(*)=0 → false → the `return ""` cold-index branch runs.
    let queried = false;
    const vector = { query: async () => { queried = true; return { matches: [] }; } } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 0 }), vector, inference: ai1024 };
    const out = await retrieveContext(infra, {
      project: "cold-unique-proj",
      repo: "o/cold-unique-repo",
      queryText: "this query is comfortably past the forty character minimum so the cold-index guard is what stops it",
    });
    expect(out).toBe("");
    expect(queried).toBe(false); // cold index → no vector query spent
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

  it("retrieveContextWithMetrics reports candidates, injected chars, and unique retrieved paths", async () => {
    const matches = [
      { id: "src/a.ts::0", score: 0.9, metadata: { path: "src/a.ts" } },
      { id: "src/a.ts::1", score: 0.8, metadata: { path: "src/a.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({
        count: 2,
        rows: [
          { id: "src/a.ts::0", text: "export const x = 1;" },
          { id: "src/a.ts::1", text: "export const y = 2;" },
        ],
      }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContextWithMetrics(infra, {
      project: "p",
      repo: "o/r",
      queryText: "refactor the auth token verification and add coverage",
      minScore: 0.5,
      reranker: "off",
    });
    expect(out.context).toContain("src/a.ts");
    expect(out.metrics).toMatchObject({
      candidates: 2,
      kept: 2,
      topScore: 0.9,
      minScore: 0.5,
      reranked: false,
      paths: ["src/a.ts"],
    });
    expect(out.metrics.injectedChars).toBeGreaterThan(0);
  });

  it("retrieves context with a configured 768-dimension self-host embedder", async () => {
    let queryVectorLength = 0;
    const vector = {
      query: async (vec: number[]) => {
        queryVectorLength = vec.length;
        return { matches: [{ id: "src/dim.ts::0", score: 0.9, metadata: { path: "src/dim.ts" } }] };
      },
    } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 1, rows: [{ id: "src/dim.ts::0", text: "export const dim = 768;" }] }),
      vector,
      inference: ai768,
      embeddingDimensions: 768,
    };
    const out = await retrieveContext(infra, {
      project: "dim-proj",
      repo: "o/dim-repo",
      queryText: "refactor the embedding pipeline while keeping vector dimensions consistent across providers",
    });
    expect(queryVectorLength).toBe(768);
    expect(out).toContain("export const dim = 768;");
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

  it("upserts configured 768-dimension self-host embedding vectors", async () => {
    const upserted: VectorUpsert[][] = [];
    const vector = { upsert: async (v: VectorUpsert[]) => { upserted.push(v); } } as unknown as VectorAdapter;
    const storage = {
      prepare: () => ({ bind: () => ({ run: async () => undefined }) as unknown as BoundStatement }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    const n = await upsertChunks({ storage, vector, inference: ai768, embeddingDimensions: 768 }, "gittensory", "o/r", chunks);
    expect(n).toBe(1);
    expect((upserted[0]?.[0]?.values ?? []).length).toBe(768);
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

  it("treats a SELECT result with NO `results` key as zero ids (the `rows.results ?? []` fallback)", async () => {
    // all() returns {} (no `results` property) → `rows.results ?? []` yields [] → no ids resolve → early return, no vector/storage delete
    let deleted = false;
    const vector = { deleteByIds: async () => { deleted = true; } } as unknown as VectorAdapter;
    const storage = {
      prepare: () => ({ bind: () => ({ all: async () => ({}), run: async () => undefined }) }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    await expect(deleteChunksForPaths({ storage, vector }, "p", "o/r", ["src/a.ts"])).resolves.toBeUndefined();
    expect(deleted).toBe(false); // no ids → nothing deleted
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

  it("readChunkTexts yields an empty Map when the SELECT returns no `results` key (the `rows.results ?? []` fallback)", async () => {
    // all() returns {} (no `results`) → `rows.results ?? []` → [] → nothing added to the map
    const storage = {
      prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    const map = await readChunkTexts(storage, ["id-1", "id-2"]);
    expect(map.size).toBe(0);
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

// ── embedTexts: the remaining validation branches in the OR-guard (#abc-verify) ───────────────────────
describe("rag: embedTexts validation branches", () => {
  it("returns null when `data` is missing entirely (not an array)", async () => {
    // res.data === undefined → !Array.isArray(data) is the FIRST OR clause
    expect(await embedTexts(aiThatReturns(undefined), ["hi"])).toBeNull();
  });

  it("returns null on a COUNT mismatch (fewer vectors than inputs)", async () => {
    // data.length(1) !== batch.length(2) → the SECOND OR clause; both vectors are correctly 1024-d
    const ai = aiThatReturns([Array(1024).fill(0.1)]);
    expect(await embedTexts(ai, ["one", "two"])).toBeNull();
  });

  it("returns null when an inner element is not an array (the `!Array.isArray(v)` leg)", async () => {
    // a structurally-valid response whose single 'vector' is a number, not an array
    expect(await embedTexts(aiThatReturns([42]), ["hi"])).toBeNull();
  });

  it("embeds ACROSS multiple batches (>EMBED_BATCH=96 inputs → the for-loop iterates more than once)", async () => {
    const calls: number[] = [];
    const inference: InferenceAdapter = {
      run: async (_model, options) => {
        const batch = (options as { text: string[] }).text;
        calls.push(batch.length);
        return { data: batch.map(() => Array(1024).fill(0.1)) };
      },
    };
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`); // 150 > 96 → two batches (96 + 54)
    const out = await embedTexts(inference, texts);
    expect(out).not.toBeNull();
    expect(out?.length).toBe(150);
    expect(calls).toEqual([96, 54]); // proves the batching loop ran twice
  });

  it("fails the WHOLE embed when a LATER batch is malformed (early-return mid-loop)", async () => {
    let call = 0;
    const inference: InferenceAdapter = {
      run: async (_model, options) => {
        const batch = (options as { text: string[] }).text;
        call += 1;
        // first batch good (1024-d), second batch wrong width (2-d) → returns null from inside the loop
        return { data: batch.map(() => (call === 1 ? Array(1024).fill(0.1) : [0.1, 0.2])) };
      },
    };
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    expect(await embedTexts(inference, texts)).toBeNull();
  });
});

// ── countRepoChunks: the `row?.n ?? 0` nullish branches ───────────────────────────────────────────────
describe("rag: countRepoChunks nullish coalescing", () => {
  it("returns 0 when the COUNT row is null (no row at all)", async () => {
    const storage = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    expect(await countRepoChunks(storage, "p", "o/r")).toBe(0); // row === null → row?.n is undefined → ?? 0
  });

  it("returns 0 when the row exists but n is null", async () => {
    const storage = {
      prepare: () => ({ bind: () => ({ first: async () => ({ n: null }) }) }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    expect(await countRepoChunks(storage, "p", "o/r")).toBe(0); // row.n === null → ?? 0
  });

  it("returns the count when the row carries a real number", async () => {
    expect(await countRepoChunks(storageStub({ count: 7 }), "p", "o/r")).toBe(7);
  });
});

// ── retrieveContext: the inner filter / default / rerank branches ─────────────────────────────────────
describe("rag: retrieveContext inner branches", () => {
  const longQuery = "this is a sufficiently long query to clear the min-length guard and reach the vector store";

  it("returns '' when the query embedding comes back empty (vec is undefined)", async () => {
    // inference returns a structurally-valid-but-empty data array → embedTexts returns [] (length 0 === batch.length 1? no)
    // Use a degraded response that makes embedTexts return null → embedded?.[0] is undefined → `if (!vec) return ""`.
    const inference: InferenceAdapter = { run: async () => ({ data: null }) };
    const vector = { query: async () => ({ matches: [] }) } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 5 }), vector, inference };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery })).toBe("");
  });

  it("drops a match with NO metadata.path (the `(m.metadata?.path) ?? ''` → falsy → filtered)", async () => {
    const matches = [
      { id: "src/nopath::0", score: 0.9, metadata: {} }, // no path → empty string → dropped
      { id: "src/ok.ts::0", score: 0.9, metadata: { path: "src/ok.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 2, rows: [{ id: "src/ok.ts::0", text: "good code" }] }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery });
    expect(out).toContain("src/ok.ts");
    expect(out).toContain("good code");
  });

  it("KEEPS a match whose score is NOT a number (the `typeof m.score !== 'number'` leg passes the minScore filter)", async () => {
    const matches = [
      { id: "src/x.ts::0", score: undefined as unknown as number, metadata: { path: "src/x.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 2, rows: [{ id: "src/x.ts::0", text: "kept despite no numeric score" }] }),
      vector,
      inference: ai1024,
    };
    // minScore 0.99 would drop a numeric-scored match, but a non-numeric score bypasses the threshold
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery, minScore: 0.99 });
    expect(out).toContain("src/x.ts");
  });

  it("returns '' when a match's chunk text is missing (texts.get → '' → filtered → no chunks)", async () => {
    const matches = [{ id: "src/gone.ts::0", score: 0.9, metadata: { path: "src/gone.ts" } }];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    // storage SELECT returns NO rows for the id → texts map is empty → chunk text '' → filtered out → no chunks → ''
    const infra: RagInfra = { storage: storageStub({ count: 2, rows: [] }), vector, inference: ai1024 };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery })).toBe("");
  });

  it("returns '' when NO matches survive (matches.length === 0 → skips readChunkTexts, empty texts map)", async () => {
    const vector = { query: async () => ({ matches: [] }) } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 2, rows: [] }), vector, inference: ai1024 };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery })).toBe("");
  });

  it("returns '' when the vector query result has NO `matches` key (the `res?.matches ?? []` fallback)", async () => {
    // query() resolves to {} (no `matches` property) → `res?.matches ?? []` → [] → no candidates → ''
    const vector = { query: async () => ({}) } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 2, rows: [] }), vector, inference: ai1024 };
    expect(await retrieveContext(infra, { project: "p", repo: "o/r", queryText: longQuery })).toBe("");
  });

  it("applies the BM25 reranker (opts.reranker='bm25' with >1 kept chunk) — reranked path", async () => {
    const matches = [
      { id: "palette.ts::0", score: 0.95, metadata: { path: "palette.ts" } }, // higher cosine but unrelated terms
      { id: "auth.ts::0", score: 0.9, metadata: { path: "auth.ts" } },
    ];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({
        count: 2,
        rows: [
          { id: "palette.ts::0", text: "export const palette = ['red','green'];" },
          { id: "auth.ts::0", text: "export function verifyAuthToken(token){ return decode(token); }" },
        ],
      }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContext(infra, {
      project: "p",
      repo: "o/r",
      queryText: "verify the auth token decode logic in the authentication module here",
      reranker: "bm25",
    });
    // BM25 promotes the term-overlapping auth.ts ahead of the higher-cosine palette.ts
    expect(out.indexOf("auth.ts")).toBeLessThan(out.indexOf("palette.ts"));
  });

  it("does NOT rerank when reranker='bm25' but only ONE chunk survives (chunks.length > 1 is false)", async () => {
    const matches = [{ id: "only.ts::0", score: 0.9, metadata: { path: "only.ts" } }];
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = {
      storage: storageStub({ count: 2, rows: [{ id: "only.ts::0", text: "single chunk" }] }),
      vector,
      inference: ai1024,
    };
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "the single chunk query that is plenty long enough", reranker: "bm25" });
    expect(out).toContain("only.ts");
  });

  it("clamps a too-large topK to RAG_MAX_TOPK=20 and applies the default minScore/excludePaths", async () => {
    let seenTopK = -1;
    const matches = [{ id: "k.ts::0", score: 0.5, metadata: { path: "k.ts" } }];
    const vector = {
      query: async (_v: number[], o: { topK: number }) => {
        seenTopK = o.topK;
        return { matches };
      },
    } as unknown as VectorAdapter;
    const infra: RagInfra = { storage: storageStub({ count: 2, rows: [{ id: "k.ts::0", text: "code" }] }), vector, inference: ai1024 };
    const out = await retrieveContext(infra, { project: "p", repo: "o/r", queryText: "a long enough query to pass the min length guard for topk", topK: 999 });
    expect(seenTopK).toBe(20); // Math.min(999, RAG_MAX_TOPK)
    expect(out).toContain("k.ts"); // default minScore=0 keeps the 0.5-scored match; default excludePaths=[] excludes nothing
  });
});

// ── hasIndexedChunks: the warm-cache hit path (skips the storage COUNT on a hot repo) ─────────────────
describe("rag: hasIndexedChunks positive-cache memoization", () => {
  it("skips the per-review storage COUNT on the SECOND call for a hot repo (cache hit within TTL)", async () => {
    let prepareCalls = 0;
    const matches = [{ id: "c.ts::0", score: 0.9, metadata: { path: "c.ts" } }];
    // COUNT(*) returns a positive n on the first call; thereafter prepare() throws so a second COUNT would surface.
    const storage = {
      prepare: (sql: string) => {
        if (sql.startsWith("SELECT COUNT")) {
          prepareCalls += 1;
          if (prepareCalls > 1) throw new Error("COUNT should be cached, not re-run");
        }
        return {
          bind: () => ({
            first: async () => ({ n: 3 }),
            all: async () => ({ results: [{ id: "c.ts::0", text: "cached-repo code" }] }),
            run: async () => undefined,
          }),
        };
      },
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    const vector = { query: async () => ({ matches }) } as unknown as VectorAdapter;
    const infra: RagInfra = { storage, vector, inference: ai1024 };
    const opts = { project: "hot", repo: "o/hot-repo", queryText: "a sufficiently long query to clear the min length guard for the cache test" };
    const first = await retrieveContext(infra, opts);
    const second = await retrieveContext(infra, opts); // would throw if it re-ran the COUNT
    expect(first).toContain("c.ts");
    expect(second).toContain("c.ts");
    expect(prepareCalls).toBe(1); // COUNT ran exactly once across both reviews
  });
});

// ── deleteChunksForPaths: the `if (vec)` false branch (storage delete only, no vector adapter) ─────────
describe("rag: deleteChunksForPaths without a vector adapter", () => {
  it("deletes from storage only when no vector adapter is injected (the `if (vec)` false leg)", async () => {
    let deleteRuns = 0;
    const storage = {
      prepare: (sql: string) => ({
        bind: () => ({
          all: async () => ({ results: sql.includes("SELECT id") ? [{ id: "ns|src/a.ts::0" }] : [] }),
          run: async () => {
            if (sql.startsWith("DELETE")) deleteRuns += 1;
          },
        }),
      }),
      batch: async () => undefined,
    } as unknown as StorageAdapter;
    await deleteChunksForPaths({ storage }, "p", "o/r", ["src/a.ts"]); // no `vector` key → if (vec) is false
    expect(deleteRuns).toBe(1); // storage DELETE still ran
  });
});

// ── bm25Scores: empty corpus + zero-frequency-term branches ───────────────────────────────────────────
describe("rag: bm25Scores edge branches", () => {
  it("returns [] for an empty doc set (the `docs.length || 1` and `avgdl || 1` guards don't divide by zero)", () => {
    expect(bm25Scores("anything", [])).toEqual([]);
  });

  it("scores 0 for a doc that shares NO query terms (every term's tf is 0 → continue)", () => {
    const scores = bm25Scores("auth token verify", ["completely unrelated words here only"]);
    expect(scores[0]).toBe(0); // no overlapping term contributes → score stays 0
  });

  it("accepts custom k1/b parameters (the defaulted-param path is overridden)", () => {
    const docs = ["auth token auth token", "single auth"];
    const def = bm25Scores("auth", docs);
    const custom = bm25Scores("auth", docs, 2.0, 0.5);
    expect(custom).toHaveLength(2);
    expect(custom[0]).not.toBe(def[0]); // different k1/b → different score
  });

  it("handles a doc that tokenizes to NOTHING (the tokenizer `?? []` + the per-doc `len = d.length || 1` guards)", () => {
    // doc 1 is pure punctuation/single chars → bm25Tokenize's regex `.match()` returns null → `?? []` → []
    // an empty token list then drives `const len = d.length || 1` to take the `|| 1` fallback (no divide-by-zero)
    const scores = bm25Scores("auth token", ["!!! @@@ a b", "verify the auth token here"]);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toBe(0); // the empty-token doc shares no query terms → scores 0, no NaN/throw
    expect(scores[1]!).toBeGreaterThan(0); // the real doc still scores
  });
});

// ── bm25Rerank: the `scores[i] ?? 0` nullish leg via a mismatched-length score array is internal; ─────
// exercise the stable-tie ordering (a.i - b.i tiebreak) and the ≤1 short-circuit.
describe("rag: bm25Rerank stable ordering", () => {
  it("keeps the original (cosine) order on a tie (the `a.i - b.i` secondary sort key)", () => {
    // two docs that produce identical BM25 scores (neither shares a query term) → stable: input order preserved
    const chunks = [
      { path: "first.ts", text: "zzz qqq" },
      { path: "second.ts", text: "www eee" },
    ];
    const out = bm25Rerank("nomatch term", chunks);
    expect(out.map((c) => c.path)).toEqual(["first.ts", "second.ts"]);
  });
});

// ── newlineChunks: the short-newline branch (a newline too close to start is NOT used as the cut) ─────
describe("rag: newlineChunks newline-boundary selection", () => {
  it("does NOT snap to a newline that falls in the first half of the chunk window (keeps the char cut)", () => {
    // One early newline near the very start, then a long unbroken run > chunkChars. The lastIndexOf('\n', end)
    // lands at the early newline (< start + chunkChars/2), so the `if (nl > start + chunkChars/2)` is FALSE and
    // the chunk is cut at the char budget, not the newline.
    const text = `a\n${"b".repeat(5000)}`; // newline at index 1, then 5000 chars with no newline
    const chunks = chunkFile("src/n.py", text, "", { chunkChars: 100, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // first chunk is ~100 chars (the budget), NOT cut back to the early newline at index 1
    expect(chunks[0]!.text.length).toBeGreaterThan(50);
    expect(chunks.every((c) => c.text.length > 0)).toBe(true);
  });

  it("snaps to a newline past the half-window (the `nl > start + chunkChars/2` TRUE branch)", () => {
    // chunkChars 100; place a newline at ~index 80 (> 50) so the cut snaps back to it.
    const text = `${"a".repeat(80)}\n${"b".repeat(200)}`;
    const chunks = chunkFile("src/n2.py", text, "", { chunkChars: 100, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.endsWith("\n")).toBe(true); // cut snapped to the newline → chunk ends at it
  });
});

// ── chunkFile / chunkJsTs: the `if (logical) return logical` true-vs-null fallback + boundaryKind legs ─
describe("rag: chunkFile JS/TS logical-vs-newline fallback", () => {
  it("falls back to the newline chunker when a JS/TS file has NO boundaries (chunkJsTs returns null → file boundary)", () => {
    // a JS file with no function/class/const-arrow/type/interface lines → segments.length <= 1 → null → newlineChunks
    const chunks = chunkFile("src/plain.js", "const a = 1;\n".replace("const a = 1;", "just some text\nmore text"));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.boundary).toBe("file"); // newline-chunker tags whole small file as 'file'
  });

  it("tags a non-exported `type X =` unit boundary as 'function' (not class, not export)", () => {
    // ~9k chars per unit → each under CHUNK_CHARS(16000) but the two together exceed it → packs into >1 chunk.
    const pad = (c: string) => Array.from({ length: 200 }, (_, i) => `  ${c}${i}: string; // padding aaaaaaaaaaaaaaaaaaaaaaaaaaaa`).join("\n");
    // first unit a `type` alias (non-export, non-class) → boundaryKind → 'function'; a second padded unit forces >1 chunk
    const text = `type Big = {\n${pad("k")}\n};\nfunction other() {\n${pad("v")}\n}\n`;
    const chunks = chunkFile("src/types.ts", text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.boundary).toBe("function"); // `type Big =` → neither export nor class → function
  });
});
