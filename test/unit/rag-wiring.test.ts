import { describe, expect, it, vi } from "vitest";
import { runGittensoryAiReview } from "../../src/services/ai-review";
import { RAG_DIMENSIONS } from "../../src/review/rag";
import { buildRagQuery, buildReviewRagContext, isRagEnabled, populateRepoIndexStub } from "../../src/review/rag-wire";
import { createTestEnv } from "../helpers/d1";

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

// ── isRagEnabled ──────────────────────────────────────────────────────────────────────────────────

describe("isRagEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isRagEnabled({})).toBe(false);
    expect(isRagEnabled({ REVIEWBOT_RAG: "false" })).toBe(false);
    expect(isRagEnabled({ REVIEWBOT_RAG: "true" })).toBe(true);
    expect(isRagEnabled({ REVIEWBOT_RAG: "1" })).toBe(true);
    expect(isRagEnabled({ REVIEWBOT_RAG: "on" })).toBe(true);
    expect(isRagEnabled({ REVIEWBOT_RAG: "yes" })).toBe(true);
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

  it("returns an empty query (nothing to retrieve on) when there are no files", () => {
    expect(buildRagQuery([])).toEqual({ queryText: "", excludePaths: [] });
  });

  it("dedupes excluded paths", () => {
    const { excludePaths } = buildRagQuery([{ path: "src/a.ts" }, { path: "src/a.ts" }, { path: "src/b.ts" }]);
    expect(excludePaths).toEqual(["src/a.ts", "src/b.ts"]);
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

  it("fail-safe: a THROWING vector query degrades to empty context (never throws)", async () => {
    const vec = { ...vectorizeStub(), query: vi.fn(async () => { throw new Error("vectorize down"); }) };
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await expect(buildReviewRagContext(env, { repoFullName: "acme/rag-throw-1", files: changedFiles })).resolves.toBe("");
  });

  it("fail-safe: no changed files → empty context, no adapter use", async () => {
    const vec = vectorizeStub();
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await buildReviewRagContext(env, { repoFullName: "acme/rag-empty", files: [] });
    expect(out).toBe("");
    expect(vec.query).not.toHaveBeenCalled();
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

describe("RAG wired into the AI reviewer (flag REVIEWBOT_RAG)", () => {
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
    const env = aiReviewEnv({ REVIEWBOT_RAG: "false", DB: ragDbStub(), VECTORIZE: vec as unknown as Vectorize, AI: aiStub() as unknown as Ai });
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

// ── Deferred index-job stub (documented follow-up) ─────────────────────────────────────────────────

describe("populateRepoIndexStub (deferred index-population follow-up)", () => {
  it("delegates to the fail-safe upsert path: 0 chunks when Vectorize/AI is absent (never throws)", async () => {
    const env = createTestEnv({ DB: ragDbStub() }); // no VECTORIZE / AI
    await expect(populateRepoIndexStub(env, "acme/widgets", [])).resolves.toBe(0);
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
