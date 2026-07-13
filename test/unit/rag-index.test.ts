import { afterEach, describe, expect, it, vi } from "vitest";
import { indexRepo, reindexChangedPaths } from "../../src/review/rag-index";
import { MAX_CHUNKS_PER_REPO, MAX_FILE_BYTES, RAG_DIMENSIONS, ragNamespace } from "../../src/review/rag";
import { processJob, splitRepoForRag } from "../../src/queue/processors";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as githubApp from "../../src/github/app";
import {
  githubRateLimitAdmissionKeyForInstallation,
  githubRateLimitAdmissionKeyForPublicToken,
  latestGitHubRestRateLimitObservation,
} from "../../src/github/client";
import { renderMetrics, resetMetrics } from "../../src/selfhost/metrics";
import { createTestEnv, TestD1Database } from "../helpers/d1";

// A valid bge-m3-width (1024-d) embedding vector — embedTexts rejects any other width.
const VEC_1024 = Array.from({ length: RAG_DIMENSIONS }, () => 0.01);

/** A Workers-AI stub: the embed model returns one 1024-d vector PER input text (embedTexts validates count+dim). */
function aiStub() {
  return {
    run: vi.fn(async (_model: string, opts: Record<string, unknown>) => {
      const texts = (opts.text as string[]) ?? [];
      return { data: texts.map(() => VEC_1024) };
    }),
  };
}

/** A Vectorize stub that records every upserted vector id + every deleted id. */
function vectorizeStub() {
  const upserted: string[] = [];
  const deleted: string[] = [];
  return {
    upserted,
    deleted,
    upsert: vi.fn(async (vectors: Array<{ id: string }>) => {
      for (const v of vectors) upserted.push(v.id);
      return { mutationId: "m1" };
    }),
    query: vi.fn(async () => ({ matches: [] })),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) deleted.push(id);
      return { mutationId: "m2" };
    }),
  };
}

/** Build an env with a REAL TestD1Database (so repo_chunks exists via migration 0051) + stubbed Vectorize/AI. */
function indexEnv(over: { vec?: ReturnType<typeof vectorizeStub>; ai?: ReturnType<typeof aiStub>; rag?: string } = {}) {
  const vec = over.vec ?? vectorizeStub();
  const ai = over.ai ?? aiStub();
  const env = createTestEnv({
    LOOPOVER_REVIEW_RAG: over.rag ?? "true",
    VECTORIZE: vec as unknown as Vectorize,
    AI: ai as unknown as Ai,
  });
  return { env, vec, ai };
}

const REPO = { fullName: "JSONbored/gittensory", installationId: null, defaultBranch: "main" };
const PROJECT = "JSONbored/gittensory";
const QUEUE_PROJECT = "JSONbored";

/** Stub global fetch for the git-tree + raw-contents calls the populator makes. */
function stubGithub(opts: {
  tree?: Array<{ path: string; type?: string; size?: number; sha?: string }>;
  files?: Record<string, string>;
  treeStatus?: number;
}) {
  const files = opts.files ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/git/trees/")) {
      if (opts.treeStatus && opts.treeStatus !== 200) return new Response("err", { status: opts.treeStatus });
      return Response.json({ tree: (opts.tree ?? []).map((n) => ({ type: "blob", ...n })), truncated: false });
    }
    if (url.includes("/contents/")) {
      // Decode the path back out of the URL to look up the canned file body.
      const match = url.match(/\/contents\/([^?]+)/);
      const path = match ? decodeURIComponent(match[1]!.split("/").map(decodeURIComponent).join("/")) : "";
      const body = files[path];
      if (body === undefined) return new Response("missing", { status: 404 });
      return new Response(body, { status: 200 });
    }
    return new Response("missing", { status: 404 });
  });
}

async function countChunks(env: Env, project: string, repo: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM repo_chunks WHERE project = ? AND repo = ?").bind(project, repo).first<{ n: number }>();
  return row?.n ?? 0;
}

async function pathsFor(env: Env, project: string, repo: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT path FROM repo_chunks WHERE project = ? AND repo = ? ORDER BY path").bind(project, repo).all<{ path: string }>();
  return [...new Set((rows.results ?? []).map((r) => r.path))];
}

describe("rag-index migration: repo_chunks exists in the test D1", () => {
  it("the 0051 migration created repo_chunks (insert + read round-trips)", async () => {
    const db = new TestD1Database() as unknown as D1Database;
    await db.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind("ns|src/a.ts::0", "p", "r", "src/a.ts", 0, "code", "x")
      .run();
    const row = await db.prepare("SELECT COUNT(*) AS n FROM repo_chunks WHERE project = ? AND repo = ?").bind("p", "r").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("indexRepo: full repo index (tree → chunk → embed → upsert)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the tree, chunks+embeds+upserts the indexable code, and persists rows to repo_chunks + Vectorize", async () => {
    const { env, vec, ai } = indexEnv();
    stubGithub({
      tree: [
        { path: "src/a.ts", size: 30 },
        { path: "README.md", size: 20 },
        { path: "node_modules/x/index.js", size: 10 }, // skipped by isIndexablePath
        { path: "data/big.json", size: 10 }, // skipped (content/data corpus)
        { path: "logo.png", size: 5 }, // skipped (binary)
      ],
      files: {
        "src/a.ts": "export const a = 1;\n",
        "README.md": "# Title\n",
      },
    });

    const result = await indexRepo(env, PROJECT, REPO);

    // Only the two indexable files were embedded + upserted.
    expect(result.files).toBe(2);
    expect(result.indexed).toBe(2);
    expect(result.capped).toBe(false);
    // The embed model was called (1024-d vectors) and Vectorize received the two chunk ids.
    expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-m3", expect.anything());
    expect(vec.upserted.length).toBe(2);
    // repo_chunks (the D1 source-of-truth text) has both rows, keyed under the repo half of the full name.
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(2);
    expect(await pathsFor(env, PROJECT, "gittensory")).toEqual(["README.md", "src/a.ts"]);
    // Ids embed the namespace (global vector ids — chunkId convention).
    const ns = ragNamespace(PROJECT, "gittensory");
    expect(vec.upserted).toContain(`${ns}|src/a.ts::0`);
  });

  it("prunes chunks for paths missing from the current full tree before returning retrieved context", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind(`${ns}|src/deleted-secret.ts::0`, PROJECT, "gittensory", "src/deleted-secret.ts", 0, "code", "deleted secret")
      .run();

    stubGithub({
      tree: [{ path: "src/current.ts", size: 30 }],
      files: { "src/current.ts": "export const current = 1;\n" },
    });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result.files).toBe(1);
    expect(await pathsFor(env, PROJECT, "gittensory")).toEqual(["src/current.ts"]);
    expect(vec.deleted).toContain(`${ns}|src/deleted-secret.ts::0`);
  });

  it("skips a file that fails to fetch (404) and indexes the rest (fail-safe)", async () => {
    const { env } = indexEnv();
    stubGithub({
      tree: [{ path: "src/a.ts" }, { path: "src/missing.ts" }],
      files: { "src/a.ts": "export const a = 1;\n" }, // src/missing.ts → 404
    });
    const result = await indexRepo(env, PROJECT, REPO);
    expect(result.files).toBe(1);
    expect(await pathsFor(env, PROJECT, "gittensory")).toEqual(["src/a.ts"]);
  });

  it("a tree fetch error degrades to nothing indexed (never throws)", async () => {
    const { env, vec } = indexEnv();
    stubGithub({ treeStatus: 500 });
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.upserted.length).toBe(0);
  });

  it("a tree fetch that THROWS degrades to nothing indexed (fetchRepoTree catch arm) + surfaces it at ERROR for Sentry (#5)", async () => {
    const { env, vec } = indexEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (input.toString().includes("/git/trees/")) throw new Error("network down");
      return new Response("missing", { status: 404 });
    });
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.upserted.length).toBe(0);
    // A broken RAG index-population (tree fetch) now surfaces at level:error → captured by the central Sentry forwarder.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("rag_index_tree_error") && String(c[0]).includes('"level":"error"'))).toBe(true);
    errSpy.mockRestore();
  });

  it("bounds the tree + contents GitHub fetches with an abort-timeout signal (a hung connection can't stall the queue worker)", async () => {
    const { env } = indexEnv();
    const inits: Array<RequestInit | undefined> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      const url = input.toString();
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: "src/a.ts", size: 20 }], truncated: false });
      if (url.includes("/contents/")) return new Response("export const a = 1;\n", { status: 200 });
      return new Response("missing", { status: 404 });
    });
    await indexRepo(env, PROJECT, REPO);
    // Both the tree fetch and each per-file contents fetch must carry an AbortSignal so a stalled GitHub connection
    // aborts (→ the existing fail-safe catches) instead of pinning the index job + its queue consumer indefinitely.
    expect(inits.length).toBeGreaterThan(1);
    expect(inits.every((i) => i?.signal instanceof AbortSignal)).toBe(true);
  });

  it("uses installation-token reads for private RAG indexing and records admission telemetry", async () => {
    const { env } = indexEnv();
    const key = githubRateLimitAdmissionKeyForInstallation(123);
    const tokenSpy = vi.spyOn(githubApp, "createInstallationToken").mockResolvedValue("install-token");
    const authHeaders: Array<string | null> = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      authHeaders.push(new Headers(init?.headers).get("authorization"));
      const headers = {
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "44",
        "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
      };
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: "src/private.ts", size: 20 }] }, { headers });
      if (url.includes("/contents/src/private.ts")) return new Response("export const privateFile = true;\n", { status: 200, headers });
      return new Response("missing", { status: 404, headers });
    });

    try {
      const result = await indexRepo(env, PROJECT, { ...REPO, installationId: 123 });

      expect(result).toMatchObject({ files: 1, indexed: 1, capped: false });
      expect(tokenSpy).toHaveBeenCalledWith(env, 123);
      expect(authHeaders).toEqual(["Bearer install-token", "Bearer install-token"]);
      expect(latestGitHubRestRateLimitObservation(key)).toEqual({
        remaining: 44,
        resetAt: "2026-06-24T12:10:00.000Z",
        observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
      });
    } finally {
      tokenSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("REGRESSION (#regression-safe-propagation): attributes the public-token fallback read to key_scope=\"public-token\", not an undefined/unknown admission key", async () => {
    const { env } = indexEnv();
    env.GITHUB_PUBLIC_TOKEN = "public-token-value";
    const key = githubRateLimitAdmissionKeyForPublicToken();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const headers = {
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "44",
        "x-ratelimit-reset": String(Date.parse("2026-06-24T12:10:00.000Z") / 1000),
      };
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ tree: [{ type: "blob", path: "src/a.ts", size: 20 }] }, { headers });
      if (url.includes("/contents/src/a.ts")) return new Response("export const a = 1;\n", { status: 200, headers });
      return new Response("missing", { status: 404, headers });
    });

    try {
      // REPO's own installationId is null -- resolveReadToken falls through to the public-token read.
      await indexRepo(env, PROJECT, REPO);
      // Before the fix, this admission-key path was left `undefined` on the public-token fallback (only the
      // installation-token branch computed a key), so this observation was silently dropped instead of
      // recorded under "public-token" -- indistinguishable from an unattributed "unknown" call on any
      // rate-limited response.
      expect(latestGitHubRestRateLimitObservation(key)).toEqual({
        remaining: 44,
        resetAt: "2026-06-24T12:10:00.000Z",
        observedAtMs: Date.parse("2026-06-24T12:00:00.000Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a storage error while listing stored paths is fail-safe (prunes nothing, still indexes) + surfaces it at ERROR for Sentry (#5)", async () => {
    const { env } = indexEnv();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Make ONLY the listStoredChunkPaths SELECT throw; everything else uses the real test D1.
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((query: string) =>
      query.includes("SELECT DISTINCT path FROM repo_chunks")
        ? ({ bind: () => ({ all: async () => { throw new Error("storage boom"); } }) } as unknown as ReturnType<typeof realPrepare>)
        : realPrepare(query)) as typeof env.DB.prepare;
    stubGithub({ tree: [{ path: "src/current.ts", size: 30 }], files: { "src/current.ts": "export const current = 1;\n" } });

    const result = await indexRepo(env, PROJECT, REPO);

    // The list failed → [] → nothing pruned, but the current file still indexes (fail-safe).
    expect(result.files).toBe(1);
    expect(await pathsFor(env, PROJECT, "gittensory")).toContain("src/current.ts");
    // A broken stored-paths read now surfaces at level:error → captured by the central Sentry forwarder.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("rag_list_paths_error") && String(c[0]).includes('"level":"error"'))).toBe(true);
    errSpy.mockRestore();
  });

  it("listStoredChunkPaths drops blank paths and tolerates an absent result set (defensive branches)", async () => {
    const { env } = indexEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    let allReturn: { results?: Array<{ path: string }> } = { results: [{ path: "" }, { path: "src/stale.ts" }] };
    env.DB.prepare = ((query: string) =>
      query.includes("SELECT DISTINCT path FROM repo_chunks")
        ? ({ bind: () => ({ all: async () => allReturn }) } as unknown as ReturnType<typeof realPrepare>)
        : realPrepare(query)) as typeof env.DB.prepare;
    // Empty tree → every stored path is stale; the blank "" is filtered out, "src/stale.ts" is pruned.
    stubGithub({ tree: [], files: {} });
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    // No `results` key at all → exercises the `?? []` defensive arm.
    allReturn = {};
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
  });

  it("a Cloudflare binding access that throws degrades to nothing indexed (indexRepo's own outer catch) + surfaces it at ERROR for Sentry with a counter (#3894)", async () => {
    const { env } = indexEnv();
    resetMetrics();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A binding CAN throw on access in real Workers runtime edge cases (revoked/misconfigured binding).
    // Every I/O step inside indexRepo already self-catches (fetchRepoTree, fetchFileText, upsertChunks,
    // resolveReadToken, ...), so this is the one realistic way to reach the function's own outer catch.
    const throwingEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "VECTORIZE") throw new Error("binding access boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(indexRepo(throwingEnv as typeof env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    const parsed = errSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(parsed.some((p) => p.level === "error" && p.event === "rag_index_repo_error" && p.ev === "rag_index_repo_error")).toBe(true);
    expect(await renderMetrics()).toContain('loopover_rag_pipeline_errors_total{op="index_repo"}');
    errSpy.mockRestore();
  });
});

describe("indexRepo: embedding cache (#4365) — skip unchanged files by git blob SHA", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips a file whose blob SHA is unchanged across two full-index runs (no re-fetch, no re-embed)", async () => {
    const { env, ai } = indexEnv();
    stubGithub({
      tree: [{ path: "src/a.ts", size: 30, sha: "sha-a-v1" }],
      files: { "src/a.ts": "export const a = 1;\n" },
    });
    const first = await indexRepo(env, PROJECT, REPO);
    expect(first).toMatchObject({ files: 1, indexed: 1 });
    const embedCallsAfterFirst = ai.run.mock.calls.length;

    // Same tree/sha, but the content fetch now 404s: if the skip logic failed to trigger, this run would
    // either drop the file (fetch fails) or spend a redundant embed call. A correctly-skipped file leaves
    // both the result and the embed-call count untouched.
    stubGithub({ tree: [{ path: "src/a.ts", size: 30, sha: "sha-a-v1" }], files: {} });
    const second = await indexRepo(env, PROJECT, REPO);

    expect(second).toEqual({ indexed: 0, files: 0, capped: false });
    expect(ai.run.mock.calls.length).toBe(embedCallsAfterFirst);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(1);
  });

  it("re-embeds a file whose blob SHA changed since the last index, replacing its old chunk row", async () => {
    const { env, ai } = indexEnv();
    stubGithub({
      tree: [{ path: "src/a.ts", size: 30, sha: "sha-a-v1" }],
      files: { "src/a.ts": "export const a = 1;\n" },
    });
    await indexRepo(env, PROJECT, REPO);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(1);

    stubGithub({
      tree: [{ path: "src/a.ts", size: 30, sha: "sha-a-v2" }],
      files: { "src/a.ts": "export const a = 2; // changed\n" },
    });
    const second = await indexRepo(env, PROJECT, REPO);

    expect(second).toMatchObject({ files: 1, indexed: 1 });
    expect(ai.run).toHaveBeenCalledTimes(2); // one embed call per run — the second run's SHA changed, so it re-embedded
    const row = await env.DB.prepare("SELECT text, blob_sha FROM repo_chunks WHERE project=? AND repo=? AND path=?")
      .bind(PROJECT, "gittensory", "src/a.ts")
      .first<{ text: string; blob_sha: string }>();
    expect(row?.text).toBe("export const a = 2; // changed\n");
    expect(row?.blob_sha).toBe("sha-a-v2");
  });

  it("removes stale trailing chunks when a changed file now chunks into FEWER pieces than it had before", async () => {
    const { env } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    // Simulate a prior index where src/a.ts had 2 chunks under an old blob SHA.
    for (const idx of [0, 1]) {
      await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text, blob_sha) VALUES (?,?,?,?,?,?,?,?)")
        .bind(`${ns}|src/a.ts::${idx}`, PROJECT, "gittensory", "src/a.ts", idx, "code", `old chunk ${idx}`, "sha-old")
        .run();
    }
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(2);

    // New tree: same path, a DIFFERENT sha, and small content that chunkFile packs into exactly one chunk.
    stubGithub({
      tree: [{ path: "src/a.ts", size: 20, sha: "sha-new" }],
      files: { "src/a.ts": "export const a = 1;\n" },
    });
    const result = await indexRepo(env, PROJECT, REPO);

    expect(result).toMatchObject({ files: 1, indexed: 1 });
    // Only the new single chunk remains — the old chunk_index:1 row was deleted, not left orphaned.
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(1);
    const row = await env.DB.prepare("SELECT id FROM repo_chunks WHERE project=? AND repo=? AND path=?")
      .bind(PROJECT, "gittensory", "src/a.ts")
      .first<{ id: string }>();
    expect(row?.id).toBe(`${ns}|src/a.ts::0`);
  });

  it("a file with no blob SHA in the tree response always reprocesses (defensive: never skips without proof of a match)", async () => {
    const { env, ai } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text, blob_sha) VALUES (?,?,?,?,?,?,?,?)")
      .bind(`${ns}|src/a.ts::0`, PROJECT, "gittensory", "src/a.ts", 0, "code", "old", "sha-old")
      .run();
    // The tree entry omits `sha` entirely (a defensive/older-API-shape case) — must not be treated as a match.
    stubGithub({ tree: [{ path: "src/a.ts", size: 20 }], files: { "src/a.ts": "export const a = 1;\n" } });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result).toMatchObject({ files: 1, indexed: 1 });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("counts pre-existing (skipped, unchanged) chunks toward the cap so a mixed skip+new run never exceeds MAX_CHUNKS_PER_REPO", async () => {
    const { env } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    const existingCount = MAX_CHUNKS_PER_REPO - 1;
    await env.DB.batch(
      Array.from({ length: existingCount }, (_, i) =>
        env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text, blob_sha) VALUES (?,?,?,?,?,?,?,?)").bind(
          `${ns}|src/existing${i}.ts::0`,
          PROJECT,
          "gittensory",
          `src/existing${i}.ts`,
          0,
          "code",
          "old",
          `sha-existing-${i}`,
        ),
      ),
    );
    const tree = [
      // Unchanged (matching sha) → every one of these is skipped, not re-embedded.
      ...Array.from({ length: existingCount }, (_, i) => ({ path: `src/existing${i}.ts`, size: 10, sha: `sha-existing-${i}` })),
      // Two brand-new files — alphabetically after "existing", so reached only once the skips are exhausted.
      { path: "src/new-a.ts", size: 10 },
      { path: "src/new-b.ts", size: 10 },
    ];
    const files: Record<string, string> = { "src/new-a.ts": "export const a = 1;\n", "src/new-b.ts": "export const b = 1;\n" };
    stubGithub({ tree, files });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result.capped).toBe(true);
    expect(result.files).toBe(1); // only one of the two new files fit under the cap
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(MAX_CHUNKS_PER_REPO); // never exceeds the cap
  });

  it("refreshes changed files in a full reindex even when the repository is already capped", async () => {
    const { env, ai } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.batch(
      Array.from({ length: MAX_CHUNKS_PER_REPO }, (_, i) => {
        const path = i === 0 ? "src/changed.ts" : `src/existing${i}.ts`;
        return env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text, blob_sha) VALUES (?,?,?,?,?,?,?,?)").bind(
          `${ns}|${path}::0`,
          PROJECT,
          "gittensory",
          path,
          0,
          "code",
          i === 0 ? "old changed file" : "old",
          i === 0 ? "sha-old" : `sha-existing-${i}`,
        );
      }),
    );
    stubGithub({
      tree: [
        { path: "src/changed.ts", size: 30, sha: "sha-new" },
        ...Array.from({ length: MAX_CHUNKS_PER_REPO - 1 }, (_, i) => ({ path: `src/existing${i + 1}.ts`, size: 10, sha: `sha-existing-${i + 1}` })),
        { path: "src/new.ts", size: 10, sha: "sha-new-file" },
      ],
      files: { "src/changed.ts": "export const changed = true;\n", "src/new.ts": "export const n = 1;\n" },
    });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result).toMatchObject({ indexed: 1, files: 1, capped: true });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(MAX_CHUNKS_PER_REPO);
    const row = await env.DB.prepare("SELECT text, blob_sha FROM repo_chunks WHERE project=? AND repo=? AND path=?")
      .bind(PROJECT, "gittensory", "src/changed.ts")
      .first<{ text: string; blob_sha: string }>();
    expect(row).toEqual({ text: "export const changed = true;\n", blob_sha: "sha-new" });
  });
});

describe("indexRepo: MAX_CHUNKS_PER_REPO cap holds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stops upserting once the per-repo cap is reached", async () => {
    const { env, vec } = indexEnv();
    // More files than the cap, each producing exactly one chunk.
    const overCap = MAX_CHUNKS_PER_REPO + 25;
    const tree = Array.from({ length: overCap }, (_, i) => ({ path: `src/f${i}.ts`, size: 20 }));
    const files: Record<string, string> = {};
    for (let i = 0; i < overCap; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i};\n`;
    stubGithub({ tree, files });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result.capped).toBe(true);
    // Never exceed the cap in either store.
    expect(result.indexed).toBeLessThanOrEqual(MAX_CHUNKS_PER_REPO);
    expect(vec.upserted.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_REPO);
    expect(await countChunks(env, PROJECT, "gittensory")).toBeLessThanOrEqual(MAX_CHUNKS_PER_REPO);
    expect(result.indexed).toBe(MAX_CHUNKS_PER_REPO);
  });

  it("still indexes package.json (and other root manifest/config files) on a repo whose file count exceeds the cap (regression: manifestPriority)", async () => {
    const { env } = indexEnv();
    // Alphabetically, "package.json" sorts AFTER most of "src/f0.ts".."src/f<N>.ts" — so without
    // manifest-first prioritization it would be starved out once the cap is reached, exactly as it
    // was in prod for gittensory's own repo (#confirmed via repo_chunks query).
    const overCap = MAX_CHUNKS_PER_REPO + 25;
    const tree: Array<{ path: string; size: number }> = [
      { path: "package.json", size: 20 },
      { path: "tsconfig.json", size: 20 },
      { path: "pnpm-workspace.yaml", size: 20 },
      { path: "go.mod", size: 20 },
      { path: "Cargo.toml", size: 20 },
      { path: "pyproject.toml", size: 20 },
      { path: "requirements.txt", size: 20 },
      { path: "wrangler.jsonc", size: 20 },
      ...Array.from({ length: overCap }, (_, i) => ({ path: `src/f${i}.ts`, size: 20 })),
    ];
    const files: Record<string, string> = {
      "package.json": '{"name":"gittensory"}\n',
      "tsconfig.json": "{}\n",
      "pnpm-workspace.yaml": "packages:\n",
      "go.mod": "module example.com/foo\n",
      "Cargo.toml": "[package]\n",
      "pyproject.toml": "[project]\n",
      "requirements.txt": "flask\n",
      "wrangler.jsonc": "{}\n",
    };
    for (let i = 0; i < overCap; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i};\n`;
    stubGithub({ tree, files });

    const result = await indexRepo(env, PROJECT, REPO);

    expect(result.capped).toBe(true);
    expect(result.indexed).toBe(MAX_CHUNKS_PER_REPO);
    const indexedPaths = await pathsFor(env, PROJECT, "gittensory");
    for (const manifest of [
      "package.json",
      "tsconfig.json",
      "pnpm-workspace.yaml",
      "go.mod",
      "Cargo.toml",
      "pyproject.toml",
      "requirements.txt",
      "wrangler.jsonc",
    ]) {
      expect(indexedPaths).toContain(manifest);
    }
  });
});

describe("manifestPriority ordering (via indexRepo, well under the cap)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("orders manifest/config files first, then other code, then docs — byte-identical file SET to before when the cap never matters", async () => {
    const { env } = indexEnv();
    stubGithub({
      tree: [
        { path: "README.md", size: 10 },
        { path: "src/z.ts", size: 10 },
        { path: "package.json", size: 10 },
        { path: "src/a.ts", size: 10 },
      ],
      files: {
        "README.md": "# Title\n",
        "src/z.ts": "export const z = 1;\n",
        "package.json": '{"name":"x"}\n',
        "src/a.ts": "export const a = 1;\n",
      },
    });

    const result = await indexRepo(env, PROJECT, REPO);

    // Nowhere near the cap: every indexable file is still indexed (same SET as filePriority alone
    // would have produced) — only the ORDER of indexing/upsert changed, not the outcome.
    expect(result.capped).toBe(false);
    expect(result.files).toBe(4);
    expect(await pathsFor(env, PROJECT, "gittensory")).toEqual(["README.md", "package.json", "src/a.ts", "src/z.ts"]);
  });
});

describe("reindexChangedPaths: delete + re-upsert only the changed paths", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes the changed paths' existing chunks and re-upserts only those files", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    // Seed an existing index: two files already stored.
    for (const [path, idx] of [["src/a.ts", 0], ["src/b.ts", 0]] as const) {
      await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
        .bind(`${ns}|${path}::${idx}`, PROJECT, "gittensory", path, idx, "code", "old")
        .run();
    }
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(2);

    // Only src/a.ts changed (+ a content/data path that is NOT indexable → deleted, not re-added).
    stubGithub({ files: { "src/a.ts": "export const a = 2;\n" } });
    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/a.ts", "data/x.json"]);

    expect(result.files).toBe(1); // only src/a.ts re-indexed
    // src/b.ts (untouched) survived; src/a.ts re-upserted; data/x.json never added.
    expect(await pathsFor(env, PROJECT, "gittensory")).toEqual(["src/a.ts", "src/b.ts"]);
    // The stale src/a.ts vector was deleted from Vectorize, and the fresh one re-upserted.
    expect(vec.deleted).toContain(`${ns}|src/a.ts::0`);
    expect(vec.upserted).toContain(`${ns}|src/a.ts::0`);
    // src/b.ts was never touched (not in the changed set).
    expect(vec.deleted).not.toContain(`${ns}|src/b.ts::0`);
  });


  it("skips oversized changed files before chunking/upserting", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind(`${ns}|src/huge.ts::0`, PROJECT, "gittensory", "src/huge.ts", 0, "code", "old")
      .run();
    stubGithub({ files: { "src/huge.ts": "x".repeat(MAX_FILE_BYTES + 1) } });

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/huge.ts"]);

    expect(result).toEqual({ indexed: 0, files: 0, capped: false });
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(0);
    expect(vec.deleted).toContain(`${ns}|src/huge.ts::0`);
    expect(vec.upserted.length).toBe(0);
  });

  it("rejects a changed file whose Content-Length header already exceeds the cap (no body read)", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind(`${ns}|src/declared-big.ts::0`, PROJECT, "gittensory", "src/declared-big.ts", 0, "code", "old")
      .run();
    // Header declares an oversized length → readTextCapped bails before streaming the (small) body.
    vi.stubGlobal("fetch", async () =>
      new Response("export const a = 1;\n", { status: 200, headers: { "content-length": String(MAX_FILE_BYTES + 1) } }),
    );

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/declared-big.ts"]);

    expect(result).toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.upserted.length).toBe(0);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(0);
  });

  it("reads a changed file delivered without a readable body via arrayBuffer (within the cap)", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    // A Response built from a Blob exposes arrayBuffer() but no streamable .body in this runtime path:
    // force the no-reader branch with an explicit body-less object.
    const bytes = new TextEncoder().encode("export const a = 1;\n");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/a.ts"]);

    expect(result.files).toBe(1);
    expect(result.indexed).toBe(1);
    expect(vec.upserted).toContain(`${ns}|src/a.ts::0`);
  });

  it("rejects a body-less changed file whose arrayBuffer exceeds the cap", async () => {
    const { env, vec } = indexEnv();
    const oversized = new Uint8Array(MAX_FILE_BYTES + 1);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => oversized.buffer,
    }));

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/a.ts"]);

    expect(result).toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.upserted.length).toBe(0);
  });

  it("tolerates empty stream chunks and cancels a stream that overflows the cap (cancel rejection swallowed)", async () => {
    const { env, vec } = indexEnv();
    const reads = [
      { done: false, value: undefined }, // empty chunk → `if (!value) continue`
      { done: false, value: new Uint8Array(MAX_FILE_BYTES + 1) }, // overflow → cancel path
    ];
    let i = 0;
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => reads[i++] ?? { done: true, value: undefined },
          cancel: async () => {
            throw new Error("cancel failed"); // exercises `.catch(() => undefined)`
          },
        }),
      },
    }));

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/a.ts"]);

    expect(result).toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.upserted.length).toBe(0);
  });

  it("caps incremental reindex upserts at MAX_CHUNKS_PER_REPO", async () => {
    const { env, vec } = indexEnv();
    const overCap = MAX_CHUNKS_PER_REPO + 25;
    const files: Record<string, string> = {};
    const paths = Array.from({ length: overCap }, (_, i) => `src/f${i}.ts`);
    for (const path of paths) files[path] = `export const ${path.replace(/\W/g, "_")} = 1;\n`;
    stubGithub({ files });

    const result = await reindexChangedPaths(env, PROJECT, REPO, paths);

    expect(result.capped).toBe(true);
    expect(result.indexed).toBe(MAX_CHUNKS_PER_REPO);
    expect(vec.upserted.length).toBe(MAX_CHUNKS_PER_REPO);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(MAX_CHUNKS_PER_REPO);
  });


  it("counts existing repo chunks when capping incremental reindex", async () => {
    const { env, vec } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.batch(
      Array.from({ length: MAX_CHUNKS_PER_REPO - 1 }, (_, i) =>
        env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind(
          `${ns}|src/existing${i}.ts::0`,
          PROJECT,
          "gittensory",
          `src/existing${i}.ts`,
          0,
          "code",
          "old",
        ),
      ),
    );
    stubGithub({ files: { "src/new-a.ts": "export const a = 1;\n", "src/new-b.ts": "export const b = 1;\n" } });

    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/new-a.ts", "src/new-b.ts"]);

    expect(result.capped).toBe(true);
    expect(result.indexed).toBe(1);
    expect(vec.upserted.length).toBe(1);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(MAX_CHUNKS_PER_REPO);
  });

  it("a deleted file (404 at head) is removed and not re-added", async () => {
    const { env } = indexEnv();
    const ns = ragNamespace(PROJECT, "gittensory");
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)")
      .bind(`${ns}|src/gone.ts::0`, PROJECT, "gittensory", "src/gone.ts", 0, "code", "old")
      .run();
    stubGithub({ files: {} }); // src/gone.ts → 404
    const result = await reindexChangedPaths(env, PROJECT, REPO, ["src/gone.ts"]);
    expect(result.files).toBe(0);
    expect(await countChunks(env, PROJECT, "gittensory")).toBe(0);
  });

  it("no changed paths → no-op", async () => {
    const { env, vec } = indexEnv();
    stubGithub({ files: {} });
    await expect(reindexChangedPaths(env, PROJECT, REPO, [])).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    expect(vec.deleted.length).toBe(0);
    expect(vec.upserted.length).toBe(0);
  });

  it("a Cloudflare binding access that throws degrades to nothing indexed (reindexChangedPaths' own outer catch) + surfaces it at ERROR for Sentry with a counter (#3894)", async () => {
    const { env } = indexEnv();
    resetMetrics();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Same rationale as indexRepo's equivalent test above: every I/O step here already self-catches, so a
    // binding access throw is the one realistic way to reach this function's own outer catch.
    const throwingEnv = new Proxy(env, {
      get(target, prop, receiver) {
        if (prop === "VECTORIZE") throw new Error("binding access boom");
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(reindexChangedPaths(throwingEnv as typeof env, PROJECT, REPO, ["src/a.ts"])).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    const parsed = errSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(parsed.some((p) => p.level === "error" && p.event === "rag_reindex_paths_error" && p.ev === "rag_reindex_paths_error")).toBe(true);
    expect(await renderMetrics()).toContain('loopover_rag_pipeline_errors_total{op="reindex_paths"}');
    errSpy.mockRestore();
  });
});

describe("flag-off / missing-infra is a no-op (no GitHub fetch, no adapter use)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("indexRepo with a MISSING Vectorize binding does nothing (no tree fetch)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_RAG: "true", AI: aiStub() as unknown as Ai }); // no VECTORIZE
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("indexRepo with a MISSING AI binding does nothing (no tree fetch)", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_RAG: "true", VECTORIZE: vectorizeStub() as unknown as Vectorize }); // no AI
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(indexRepo(env, PROJECT, REPO)).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reindexChangedPaths with missing infra does nothing", async () => {
    const env = createTestEnv({ LOOPOVER_REVIEW_RAG: "true" }); // no VECTORIZE / AI
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(reindexChangedPaths(env, PROJECT, REPO, ["src/a.ts"])).resolves.toEqual({ indexed: 0, files: 0, capped: false });
    // Note: deleteChunksForPaths runs first (storage is always present) but no vector/embed work or GitHub fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── Wiring: the rag-index-repo queue job (cron fan-out + per-repo dispatch) ─────────────────────────

/** Register a repo (is_registered = 1) so it joins the cron fan-out's registered set. */
async function registerRepo(env: Env, fullName: string, installationId: number | null = 123): Promise<void> {
  const [owner, name] = fullName.split("/") as [string, string];
  await upsertRepositoryFromGitHub(env, { name, full_name: fullName, private: false, owner: { login: owner } }, installationId ?? undefined);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(fullName).run();
}

describe("rag-index-repo job dispatch (processors.ts wiring)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("FLAG-ON cron fan-out enqueues one per-repo job for every REGISTERED + ALLOWLISTED repo only", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "true",
      // Allowlist only JSONbored/gittensory (acme/widgets is allowlisted by default but won't be registered here).
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory,JSONbored/metagraphed",
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await registerRepo(env, "JSONbored/gittensory"); // registered + allowlisted → indexed
    await registerRepo(env, "JSONbored/metagraphed", null); // registered + allowlisted but not installed → indexed without installation metadata
    await registerRepo(env, "owner/not-allowlisted"); // registered but NOT allowlisted → skipped

    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule" });

    expect(sent).toEqual([
      { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/gittensory", installationId: 123 },
      { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/metagraphed" },
    ]);
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("rag.index.fanout").first<{
      outcome: string;
      metadata_json: string;
    }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 2, requestedBy: "schedule" });
  });

  it("cron fan-out ALSO indexes CONFIGURED (LOOPOVER_REVIEW_REPOS) repos never registered via webhook (brokered self-host fix)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/metagraphed, JSONbored/gittensory", // configured, NOT registered (is_registered=0)
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    // No registerRepo() — these are is_registered=0 (the brokered model); the old registered-only fan-out indexed NOTHING.
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule" });
    expect(sent.map((m) => (m as { repoFullName?: string }).repoFullName).sort()).toEqual(["JSONbored/gittensory", "JSONbored/metagraphed"]);
  });

  it("dedupes a repo that is BOTH registered and configured (no double-index)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "true",
      LOOPOVER_REVIEW_REPOS: "JSONbored/gittensory",
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await registerRepo(env, "JSONbored/gittensory"); // registered AND configured → must appear exactly once
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule" });
    expect(sent.filter((m) => (m as { repoFullName?: string }).repoFullName === "JSONbored/gittensory").length).toBe(1);
  });

  it("FLAG-OFF cron fan-out is a no-op (no per-repo jobs enqueued, no fan-out audit)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "false",
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await registerRepo(env, "JSONbored/gittensory");
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule" });
    expect(sent).toHaveLength(0);
    const fanout = await env.DB.prepare("select 1 from audit_events where event_type = ?").bind("rag.index.fanout").first();
    expect(fanout).toBeFalsy(); // no fan-out audit row (TestD1 returns undefined for no-row)
  });

  it("per-repo FULL index dispatch runs indexRepo (writes repo_chunks) for an allowlisted repo", async () => {
    const { env } = indexEnv({ rag: "true" });
    await registerRepo(env, "JSONbored/gittensory");
    stubGithub({ tree: [{ path: "src/a.ts", size: 30 }], files: { "src/a.ts": "export const a = 1;\n" } });
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/gittensory" });
    expect(await countChunks(env, QUEUE_PROJECT, "gittensory")).toBe(1);
  });

  it("per-repo dispatch SKIPS a repo where RAG is not active (no indexing)", async () => {
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "true",
      LOOPOVER_REVIEW_REPOS: "", // empty allowlist → not active (no per-repo features.rag override either)
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: aiStub() as unknown as Ai,
    });
    await registerRepo(env, "JSONbored/gittensory");
    // The manifest IS consulted now (that's how a per-repo `features.rag: true` override would activate an
    // un-allowlisted repo); it returns no manifest here, so the repo stays inactive and is never indexed.
    const fetchSpy = vi.fn(async (url: RequestInfo | URL) => new Response("", { status: 404, headers: { "x-url": String(url) } }));
    vi.stubGlobal("fetch", fetchSpy);
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/gittensory" });
    // No indexing work: the GitHub git/trees endpoint (the index walk) was never hit.
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("/git/trees/"))).toBe(false);
    expect(await countChunks(env, QUEUE_PROJECT, "gittensory")).toBe(0);
  });

  it("per-repo dispatch INDEXES an un-allowlisted repo when features.rag is overridden on via the private config", async () => {
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "true",
      LOOPOVER_REVIEW_REPOS: "", // not allowlisted — only the per-repo override activates it
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: aiStub() as unknown as Ai,
    });
    await registerRepo(env, "JSONbored/gittensory");
    // Private-config override: features.rag = true. upsert persists it as an api_record the loader reads.
    await upsertRepoFocusManifest(env, "JSONbored/gittensory", { features: { rag: true } });
    stubGithub({ tree: [{ path: "src/a.ts", size: 30 }], files: { "src/a.ts": "export const a = 1;\n" } });
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/gittensory" });
    expect(await countChunks(env, QUEUE_PROJECT, "gittensory")).toBe(1); // indexed despite the empty allowlist
  });

  it("per-repo INCREMENTAL dispatch (with paths) runs reindexChangedPaths", async () => {
    const { env } = indexEnv({ rag: "true" });
    await registerRepo(env, "JSONbored/gittensory");
    stubGithub({ files: { "src/a.ts": "export const a = 1;\n" } });
    await processJob(env, { type: "rag-index-repo", requestedBy: "webhook", repoFullName: "JSONbored/gittensory", paths: ["src/a.ts"] });
    expect(await pathsFor(env, QUEUE_PROJECT, "gittensory")).toEqual(["src/a.ts"]);
  });

  it("FLAG-OFF per-repo dispatch is a no-op", async () => {
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: "false",
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: aiStub() as unknown as Ai,
    });
    await registerRepo(env, "JSONbored/gittensory");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await processJob(env, { type: "rag-index-repo", requestedBy: "schedule", repoFullName: "JSONbored/gittensory" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await countChunks(env, QUEUE_PROJECT, "gittensory")).toBe(0);
  });
});

// ── Wiring: the merged-PR incremental trigger (github-webhook) ──────────────────────────────────────

describe("merged-PR incremental re-index trigger (webhook)", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Drive a pull_request webhook for a MERGED close and capture the enqueued jobs. */
  async function runMergedPrWebhook(over: { rag?: string; repos?: string; merged?: boolean; files?: string[] }): Promise<import("../../src/types").JobMessage[]> {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_RAG: over.rag ?? "true",
      LOOPOVER_REVIEW_REPOS: over.repos ?? "JSONbored/gittensory",
      JOBS: { async send(message: import("../../src/types").JobMessage) { sent.push(message); } } as unknown as Queue,
    });
    await registerRepo(env, "JSONbored/gittensory");
    // Seed the PR's changed files so listPullRequestFiles returns them.
    for (const path of over.files ?? ["src/a.ts", "README.md"]) {
      await env.DB.prepare(
        "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?,?,?,?,?,?,?,?)",
      ).bind("JSONbored/gittensory", 42, path, "modified", 1, 0, 1, "{}").run();
    }
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    await processJob(env, {
      type: "github-webhook",
      deliveryId: "d-merge",
      eventName: "pull_request",
      payload: {
        action: "closed",
        installation: { id: 123 },
        repository: { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } },
        pull_request: {
          number: 42,
          title: "Merge me",
          state: "closed",
          merged_at: over.merged === false ? null : "2026-06-22T00:00:00.000Z",
          user: { login: "alice" },
          head: { sha: "h42" },
          base: { ref: "main" },
        },
      },
    });
    return sent.filter((m) => m.type === "rag-index-repo");
  }

  it("a MERGED PR into an allowlisted repo enqueues a rag-index-repo job with the changed paths and installationId", async () => {
    const ragJobs = await runMergedPrWebhook({});
    // REGRESSION (#rate-limit-admission-attribution): installationId must be threaded through so the queue's
    // admission check attributes this job to the repo's OWN installation bucket, not the shared public-token
    // bucket -- omitting it starves an installed repo's re-index behind unrelated public-token traffic.
    // paths reflects listPullRequestFiles's deterministic path-ascending order (#linked-issue-satisfaction-cache-fingerprint-stability),
    // not the seed/insertion order above -- "README.md" sorts before "src/a.ts".
    expect(ragJobs).toEqual([
      { type: "rag-index-repo", requestedBy: "webhook", repoFullName: "JSONbored/gittensory", paths: ["README.md", "src/a.ts"], installationId: 123 },
    ]);
  });

  it("a CLOSED-UNMERGED PR (merged_at null) enqueues nothing (base unchanged)", async () => {
    expect(await runMergedPrWebhook({ merged: false })).toEqual([]);
  });

  it("FLAG-OFF enqueues nothing", async () => {
    expect(await runMergedPrWebhook({ rag: "false" })).toEqual([]);
  });

  it("a non-allowlisted repo enqueues nothing", async () => {
    expect(await runMergedPrWebhook({ repos: "" })).toEqual([]);
  });
});

describe("splitRepoForRag", () => {
  it("splits owner/name into the shared project/repo key shape", () => {
    expect(splitRepoForRag("JSONbored/gittensory")).toEqual(["JSONbored", "gittensory"]);
  });

  it("falls back to an empty project for a bare repo name (no slash)", () => {
    // The slash === -1 arm — indexing and retrieval must agree on this shape for a name without an owner.
    expect(splitRepoForRag("bareRepoName")).toEqual(["", "bareRepoName"]);
  });
});
