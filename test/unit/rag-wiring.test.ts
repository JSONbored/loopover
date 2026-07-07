import { afterEach, describe, expect, it, vi } from "vitest";
import { runGittensoryAiReview } from "../../src/services/ai-review";
import { runAiReviewForAdvisory } from "../../src/queue/processors";
import * as ragModule from "../../src/review/rag";
import { RAG_DIMENSIONS } from "../../src/review/rag";
import {
  attributeReviewRagTelemetry,
  buildRagQuery,
  buildReviewRagContext,
  buildReviewRagContextWithMetrics,
  emptyReviewRagTelemetry,
  isRagEnabled,
} from "../../src/review/rag-wire";
import { createTestEnv } from "../helpers/d1";
import type { Advisory, RepositorySettings } from "../../src/types";

// ── Test fixtures ────────────────────────────────────────────────────────────────────────────────

const notesJson = JSON.stringify({
  assessment: "Looks fine.",
  suggestions: [],
  risks: [],
  criticalDefect: { present: false, confidence: 0, title: "", detail: "" },
});

/** A valid bge-m3-width (1024-d) embedding vector — `embedTexts` rejects any other width. */
const VEC_1024 = Array.from({ length: RAG_DIMENSIONS }, () => 0.01);

/**
 * A D1-shaped DB stub for the RAG retrieval path. It answers:
 *   - the cold-index COUNT (`SELECT COUNT(*) … repo_chunks`) → { n } (default > 0 so the index reads as warm)
 *   - the chunk-text read (`SELECT id, text … repo_chunks WHERE id IN (…)`) → the fixture chunk rows
 * So `retrieveContext` can run end-to-end without a real D1 schema.
 */
function ragDbStub(opts: { count?: number; chunkRows?: Array<{ id: string; text: string }> } = {}) {
  const count = opts.count ?? 5;
  const chunkRows = opts.chunkRows ?? [{ id: "v1", text: "export function helper() { return 1; }" }];
  const prepared = (sql: string) => ({
    bind: (..._values: unknown[]) => ({
      first: vi.fn(async () => (/COUNT\(\*\)/i.test(sql) ? { n: count } : null)),
      all: vi.fn(async () => ({ results: /SELECT id, text/i.test(sql) ? chunkRows : [] })),
      run: vi.fn(async () => undefined),
    }),
  });
  return { prepare: vi.fn((sql: string) => prepared(sql)), batch: vi.fn(async () => []) } as unknown as D1Database;
}

/** A Vectorize stub returning a canned match set (one neighbour at path `src/helper.ts`). */
function vectorizeStub(matches = [{ id: "v1", score: 0.92, metadata: { path: "src/helper.ts" } }]) {
  return {
    upsert: vi.fn(async () => ({ mutationId: "m1" })),
    query: vi.fn(async () => ({ matches })),
    deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
  };
}

/** A Workers-AI stub: the embed model returns a 1024-d vector; the chat path returns the canned notes JSON. */
function aiStub() {
  return {
    run: vi.fn(async (model: string, _opts: Record<string, unknown>) =>
      model === "@cf/baai/bge-m3" ? { data: [VEC_1024] } : { response: notesJson },
    ),
  };
}

const baseReviewInput = {
  repoFullName: "acme/widgets",
  prNumber: 7,
  title: "Add a feature",
  body: "Implements the thing.",
  diff: "### src/a.ts (modified) +1/-0\n@@\n+export const A = 1;",
  actor: "alice",
  mode: "advisory" as const,
  providerKey: null,
};

const changedFiles = [{ path: "src/a.ts", patch: "@@\n+export const A = helper();" }];
const emptyRetrievalMetrics = {
  candidates: 0,
  kept: 0,
  topScore: 0,
  minScore: 0.4,
  reranked: false,
  injectedChars: 0,
  paths: [],
};

// ── isRagEnabled ──────────────────────────────────────────────────────────────────────────────────

describe("isRagEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isRagEnabled({})).toBe(false);
    expect(isRagEnabled({ GITTENSORY_REVIEW_RAG: "false" })).toBe(false);
    expect(isRagEnabled({ GITTENSORY_REVIEW_RAG: "true" })).toBe(true);
    expect(isRagEnabled({ GITTENSORY_REVIEW_RAG: "1" })).toBe(true);
    expect(isRagEnabled({ GITTENSORY_REVIEW_RAG: "on" })).toBe(true);
    expect(isRagEnabled({ GITTENSORY_REVIEW_RAG: "yes" })).toBe(true);
  });
});

// ── buildRagQuery (the query composer) ─────────────────────────────────────────────────────────────

describe("buildRagQuery composes the retrieval query from the changed files", () => {
  it("embeds the changed paths + a diff sample and excludes the changed paths from results", () => {
    const { queryText, excludePaths } = buildRagQuery(changedFiles);
    expect(queryText).toContain("Changed files:");
    expect(queryText).toContain("src/a.ts");
    expect(queryText).toContain("helper()");
    expect(excludePaths).toEqual(["src/a.ts"]);
  });

  it("PREPENDS the PR title to the query text (recall parity with reviewbot)", () => {
    const { queryText } = buildRagQuery(changedFiles, "Refactor the auth middleware");
    expect(queryText).toContain("Refactor the auth middleware");
    // The title leads the query (before the "Changed files:" block).
    expect(queryText.indexOf("Refactor the auth middleware")).toBeLessThan(queryText.indexOf("Changed files:"));
    // The diff sample is still present (title is ADDITIVE, not a replacement).
    expect(queryText).toContain("helper()");
  });

  it("omits a blank/whitespace title cleanly (query still starts with the Changed files block)", () => {
    expect(buildRagQuery(changedFiles, "   ").queryText.startsWith("Changed files:")).toBe(true);
    expect(buildRagQuery(changedFiles, undefined).queryText.startsWith("Changed files:")).toBe(true);
  });

  it("returns an empty query (nothing to retrieve on) when there are no files", () => {
    expect(buildRagQuery([])).toEqual({ queryText: "", excludePaths: [] });
    expect(buildRagQuery([], "Some title")).toEqual({ queryText: "", excludePaths: [] });
  });

  it("dedupes excluded paths", () => {
    const { excludePaths } = buildRagQuery([{ path: "src/a.ts" }, { path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(excludePaths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stops sampling patches after the bounded diff budget is reached", () => {
    const largePatch = `@@\n+${"x".repeat(4100)}`;
    const { queryText } = buildRagQuery([
      { path: "src/large.ts", patch: largePatch },
      { path: "src/skipped.ts", patch: "@@\n+SHOULD_NOT_APPEAR" },
    ]);
    expect(queryText).toContain("src/skipped.ts");
    expect(queryText).not.toContain("SHOULD_NOT_APPEAR");
  });
});

// ── buildReviewRagContext (retrieval, fail-safe) ───────────────────────────────────────────────────

describe("buildReviewRagContext: retrieval wiring + fail-safe", () => {
  it("FLAG-ON with a warm index: returns the retrieved RELEVANT EXISTING CODE / DOCS block", async () => {
    const vec = vectorizeStub();
    const ai = aiStub();
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: ai as unknown as Ai });
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-warm-1", files: changedFiles });
    expect(out).toContain("RELEVANT EXISTING CODE / DOCS");
    expect(out).toContain("src/helper.ts");
    expect(out).toContain("export function helper()");
    // The query was embedded and the vector index was queried.
    expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-m3", expect.anything());
    expect(vec.query).toHaveBeenCalledTimes(1);
  });

  it("FLAG-ON with a warm index: returns retrieval telemetry for later attribution", async () => {
    const vec = vectorizeStub();
    const ai = aiStub();
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: ai as unknown as Ai });
    const out = await buildReviewRagContextWithMetrics(env, { repoFullName: "acme/rag-warm-metrics", files: changedFiles });
    expect(out.text).toContain("RELEVANT EXISTING CODE / DOCS");
    expect(out.telemetry).toMatchObject({
      enabled: true,
      attempted: true,
      injected: true,
      candidates: 1,
      kept: 1,
      topScore: 0.92,
      minScore: 0.4,
      reranked: false,
      retrievedPathCount: 1,
      retrievedPaths: ["src/helper.ts"],
    });
    expect(out.telemetry.injectedChars).toBeGreaterThan(0);
  });

  it("fail-safe: a MISSING Vectorize binding → empty context, NO vector query attempted", async () => {
    const env = createTestEnv({ DB: ragDbStub(), AI: aiStub() as unknown as Ai }); // no VECTORIZE
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-novec", files: changedFiles });
    expect(out).toBe("");
  });

  it("fail-safe: a MISSING AI binding → empty context (no embedder)", async () => {
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize }); // no AI
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-noai", files: changedFiles });
    expect(out).toBe("");
  });

  it("fail-safe: a COLD/empty index (count 0) → empty context, no embed/query spent", async () => {
    const vec = vectorizeStub();
    const ai = aiStub();
    const env = createTestEnv({ DB: ragDbStub({ count: 0 }), VECTORIZE: vec as unknown as Vectorize, AI: ai as unknown as Ai });
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-cold-1", files: changedFiles });
    expect(out).toBe("");
    expect(ai.run).not.toHaveBeenCalled();
    expect(vec.query).not.toHaveBeenCalled();
  });

  it("fail-safe: a THROWING vector query degrades to empty context (never throws) + surfaces it at ERROR for Sentry (#5)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vec = { ...vectorizeStub(), query: vi.fn(async () => { throw new Error("vectorize down"); }) };
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await expect(buildReviewRagContext(env, { repoFullName: "acme/rag-throw-1", files: changedFiles })).resolves.toBe("");
    // A broken RAG backend now surfaces at level:error (central Sentry forwarder) instead of degrading invisibly.
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("review_context_fetch_failed") && String(c[0]).includes('"contextType":"rag"'))).toBe(true);
    errSpy.mockRestore();
  });

  it("fail-safe: no changed files → empty context, no adapter use", async () => {
    const vec = vectorizeStub();
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-empty", files: [] });
    expect(out).toBe("");
    expect(vec.query).not.toHaveBeenCalled();
  });
});

// ── Quality knobs (#GAP-2): minScore + reranker + title flow into retrieveContext ──────────────────

describe("buildReviewRagContext passes the quality knobs into retrieveContext (#GAP-2)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("invokes the retrieve call with minScore 0.4 + reranker 'bm25' and the title-led query (reviewbot parity)", async () => {
    const spy = vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "=== RELEVANT EXISTING CODE / DOCS ===",
      metrics: emptyRetrievalMetrics,
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await buildReviewRagContext(env, { repoFullName: "acme/widgets", title: "Add a feature", files: changedFiles });
    expect(out).toContain("RELEVANT EXISTING CODE / DOCS");
    expect(spy).toHaveBeenCalledTimes(1);
    const opts = spy.mock.calls[0]?.[1];
    expect(opts).toMatchObject({ minScore: 0.4, reranker: "bm25", project: "acme", repo: "widgets" });
    // The title leads the embedded query (recall parity with reviewbot).
    expect(opts?.queryText).toContain("Add a feature");
    expect(opts?.queryText.indexOf("Add a feature")).toBeLessThan(opts?.queryText.indexOf("Changed files:") ?? -1);
  });

  it("a caller-supplied reranker still wins over the default (e.g. forcing it off), minScore unchanged", async () => {
    const spy = vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "",
      metrics: emptyRetrievalMetrics,
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await buildReviewRagContext(env, { repoFullName: "acme/widgets", files: changedFiles, reranker: "off" });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ minScore: 0.4, reranker: "off" });
  });

  it("handles slashless repo names by using an empty project namespace", async () => {
    const spy = vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "",
      metrics: emptyRetrievalMetrics,
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await buildReviewRagContext(env, { repoFullName: "widgets", files: changedFiles });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ project: "", repo: "widgets" });
  });
});

describe("RAG review attribution telemetry", () => {
  it("marks findings and notes that reference retrieved paths", () => {
    const telemetry = {
      ...emptyReviewRagTelemetry(true),
      attempted: true,
      injected: true,
      retrievedPathCount: 2,
      retrievedPaths: ["src/helper.ts", "src/unused.ts"],
    };
    const out = attributeReviewRagTelemetry(telemetry, {
      notes: "The existing convention in src/unused.ts is preserved.",
      findings: [{ title: "Bug", detail: "src/helper.ts now returns the wrong value.", action: "Fix it." }],
      inlineFindings: [{ path: "src/a.ts", body: "Compare against src/helper.ts." }],
    });
    expect(out.findingReferencedRetrievedPath).toBe(true);
    expect(out.notesReferencedRetrievedPath).toBe(true);
    expect(out.referencedRetrievedPathCount).toBe(2);
    expect(out.referencedRetrievedPaths).toEqual(["src/helper.ts", "src/unused.ts"]);
  });

  it("returns unchanged telemetry when no paths were retrieved", () => {
    const telemetry = emptyReviewRagTelemetry(true);
    expect(attributeReviewRagTelemetry(telemetry, { notes: "No context." })).toBe(telemetry);
  });

  it("treats omitted attribution fields as empty text", () => {
    const telemetry = {
      ...emptyReviewRagTelemetry(true),
      retrievedPathCount: 1,
      retrievedPaths: ["src/helper.ts"],
    };
    expect(
      attributeReviewRagTelemetry(telemetry, {
        notes: null,
        findings: [{}],
        inlineFindings: [{}],
      }),
    ).toMatchObject({
      findingReferencedRetrievedPath: false,
      notesReferencedRetrievedPath: false,
      referencedRetrievedPathCount: 0,
      referencedRetrievedPaths: [],
    });
  });

  it("handles omitted finding and inline arrays while still attributing notes", () => {
    const telemetry = {
      ...emptyReviewRagTelemetry(true),
      retrievedPathCount: 1,
      retrievedPaths: ["src/helper.ts"],
    };
    expect(
      attributeReviewRagTelemetry(telemetry, {
        notes: "The review followed src/helper.ts.",
      }),
    ).toMatchObject({
      findingReferencedRetrievedPath: false,
      notesReferencedRetrievedPath: true,
      referencedRetrievedPathCount: 1,
      referencedRetrievedPaths: ["src/helper.ts"],
    });
  });
});

// ── End-to-end: flag-gated RAG context through runGittensoryAiReview ───────────────────────────────

/** Capture the exact user prompt handed to the chat model so we can assert what the AI actually sees. */
function capturingChatRun() {
  const seenUser: string[] = [];
  const run = vi.fn(async (model: string, options: { messages?: Array<{ role: string; content: string }> }) => {
    if (model === "@cf/baai/bge-m3") return { data: [VEC_1024] };
    const userMsg = options.messages?.find((m) => m.role === "user");
    if (userMsg) seenUser.push(userMsg.content);
    return { response: notesJson };
  });
  return { run, seenUser };
}

function aiReviewEnv(over: Partial<Env> = {}) {
  return createTestEnv({
    AI_SUMMARIES_ENABLED: "true",
    AI_PUBLIC_COMMENTS_ENABLED: "true",
    AI_DAILY_NEURON_BUDGET: "100000",
    ...over,
  });
}

describe("RAG wired into the AI reviewer (flag GITTENSORY_REVIEW_RAG)", () => {
  it("FLAG-ON: the user prompt gains the RELEVANT EXISTING CODE / DOCS section", async () => {
    // Retrieve the RAG block with a stubbed Vectorize/AI/DB (the retrieval seam is exercised here)…
    const retrievalEnv = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const ragContext = await buildReviewRagContext(retrievalEnv, { repoFullName: "acme/rag-e2e-on", files: changedFiles });
    expect(ragContext).toContain("RELEVANT EXISTING CODE / DOCS");

    // …then run the reviewer with the real TestD1Database env (the budget/audit reads need a real D1) and the
    // chat-capturing AI, and assert the retrieved block is spliced into the user prompt.
    const { run, seenUser } = capturingChatRun();
    const env = aiReviewEnv({ AI: { run } as unknown as Ai });
    const result = await runGittensoryAiReview(env, { ...baseReviewInput, ragContext });
    expect(result.status).toBe("ok");
    const user = seenUser[0] ?? "";
    expect(user).toContain("RELEVANT EXISTING CODE / DOCS");
    expect(user).toContain("src/helper.ts");
    expect(user).toContain("export function helper()");
    // The original diff section is still present (RAG is additive, not a replacement).
    expect(user).toContain("Unified diff (truncated if large):");
  });

  it("FLAG-ON via runAiReviewForAdvisory: maps the changed files into the RAG retrieval (both patch / no-patch sides)", async () => {
    // Drives the call site (processors.ts) so the `files.map(...)` that builds the RAG `files` arg runs —
    // including BOTH ternary sides of `typeof file.payload?.patch === "string" ? … : undefined`.
    const env = aiReviewEnv({
      GITTENSORY_REVIEW_RAG: "true",
      VECTORIZE: vectorizeStub() as unknown as Vectorize,
      AI: { run: capturingChatRun().run } as unknown as Ai,
    });
    // Seed two changed-file rows: one with a real string patch, one whose payload has NO patch.
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme/widgets", 3, "src/a.ts", "modified", 1, 0, 1, JSON.stringify({ patch: "@@\n+export const A = helper();" })).run();
    await env.DB.prepare(
      "INSERT INTO pull_request_files (repo_full_name, pull_number, path, status, additions, deletions, changes, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("acme/widgets", 3, "img/logo.png", "added", 0, 0, 0, JSON.stringify({})).run(); // no `patch` → undefined branch
    await env.DB.prepare(
      "INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("v1", "acme", "widgets", "src/helper.ts", 0, "code", "export function helper() { return 1; }").run();
    const adv: Advisory = {
      id: "adv-rag", targetType: "pull_request", targetKey: "acme/widgets#3", repoFullName: "acme/widgets",
      pullNumber: 3, headSha: "sha3", conclusion: "neutral", severity: "info",
      title: "Gittensory advisory available", summary: "ok", findings: [], generatedAt: "2026-06-20T00:00:00.000Z",
    };
    const result = await runAiReviewForAdvisory(env, {
      settings: { aiReviewMode: "advisory" } as RepositorySettings,
      repoFullName: "acme/widgets",
      pr: { number: 3, title: "Add helper", body: "Adds a helper." },
      author: "alice",
      confirmedContributor: true,
      advisory: adv,
    });
    // The review still completes (RAG is additive + fail-safe); the map having run is what we're exercising.
    expect(result?.notes ?? "").toBeDefined();
    expect(result?.metadata?.rag).toMatchObject({
      enabled: true,
      attempted: true,
      injected: true,
      retrievedPaths: ["src/helper.ts"],
      notesReferencedRetrievedPath: false,
      findingReferencedRetrievedPath: false,
    });
  }, 60_000);

  it("FLAG-OFF (default): the prompt is byte-identical to the no-RAG prompt (ragContext undefined)", async () => {
    // The flag-OFF call site leaves ragContext undefined; the prompt must equal the no-RAG prompt.
    const off = capturingChatRun();
    const offEnv = aiReviewEnv({ AI: { run: off.run } as unknown as Ai });
    await runGittensoryAiReview(offEnv, { ...baseReviewInput, ragContext: undefined });

    const none = capturingChatRun();
    const noneEnv = aiReviewEnv({ AI: { run: none.run } as unknown as Ai });
    await runGittensoryAiReview(noneEnv, baseReviewInput);

    expect(off.seenUser[0]).not.toContain("RELEVANT EXISTING CODE / DOCS");
    // undefined ragContext === absent: identical prompts, proving flag-OFF appends no section.
    expect(none.seenUser[0]).toBe(off.seenUser[0]);
  });

  it("FLAG-OFF call site performs NO retrieval (no adapter use, no vector query)", async () => {
    // Mirror the caller's flag gate: when isRagEnabled is false the call site never invokes
    // buildReviewRagContext, so no adapter is built and no query is issued.
    const vec = vectorizeStub();
    const env = aiReviewEnv({ GITTENSORY_REVIEW_RAG: "false", DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const ragContext = isRagEnabled(env) ? await buildReviewRagContext(env, { repoFullName: "acme/rag-offgate", files: changedFiles }) : undefined;
    expect(ragContext).toBeUndefined();
    expect(vec.query).not.toHaveBeenCalled();
  });

  it("FLAG-ON but EMPTY context (cold/missing index): prompt is byte-identical to flag-OFF", async () => {
    // When the flag is on but retrieval yields "" (no index), the prompt must match the no-context prompt.
    const on = capturingChatRun();
    const onEnv = aiReviewEnv({ AI: { run: on.run } as unknown as Ai });
    await runGittensoryAiReview(onEnv, { ...baseReviewInput, ragContext: "" });

    const none = capturingChatRun();
    const noneEnv = aiReviewEnv({ AI: { run: none.run } as unknown as Ai });
    await runGittensoryAiReview(noneEnv, baseReviewInput);

    expect(on.seenUser[0]).not.toContain("RELEVANT EXISTING CODE / DOCS");
    expect(on.seenUser[0]).toBe(none.seenUser[0]);
  });
});


describe("buildReviewRagContext outer fail-safe", () => {
  it("returns '' (never throws) when query construction throws", async () => {
    const env = createTestEnv({ DB: ragDbStub() });
    // A file whose `path` getter throws makes buildRagQuery throw inside the try → outer catch → "".
    const poison = { get path(): string { throw new Error("boom"); } } as unknown as { path: string; patch?: string };
    await expect(buildReviewRagContext(env, { repoFullName: "acme/widgets", files: [poison] })).resolves.toBe("");
  });
});
