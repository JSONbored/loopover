import { describe, expect, it, vi } from "vitest";
import {
  createReviewAdapters,
  reviewInferenceAdapter,
  reviewStorageAdapter,
  reviewVectorAdapter,
} from "../../src/review/adapters";
import { createTestEnv } from "../helpers/d1";

// ── Minimal Env stubs ─────────────────────────────────────────────────────────────────────────────
// Only the bindings the factory touches (DB / VECTORIZE / AI) are stubbed; the factory is given an
// `as Env` cast so we don't have to satisfy the whole ambient interface for a focused unit test.

/** A D1-shaped stub recording the SQL it prepared + the values bound, returning canned results. */
function dbStub() {
  const calls: { prepare: string[]; bind: unknown[][]; batched: number } = { prepare: [], bind: [], batched: 0 };
  const bound = {
    first: vi.fn(async () => ({ n: 7 })),
    all: vi.fn(async () => ({ results: [{ id: "a", text: "x" }] })),
    run: vi.fn(async () => undefined),
  };
  const prepared = {
    bind: vi.fn((...values: unknown[]) => {
      calls.bind.push(values);
      return bound;
    }),
  };
  const DB = {
    prepare: vi.fn((q: string) => {
      calls.prepare.push(q);
      return prepared;
    }),
    batch: vi.fn(async (_stmts: unknown[]) => {
      calls.batched += 1;
      return [];
    }),
  };
  return { DB, calls, bound, prepared };
}

/** A Vectorize-shaped stub recording calls + returning a canned match set. */
function vectorizeStub() {
  return {
    upsert: vi.fn(async (_vectors: unknown[]) => ({ mutationId: "m1" })),
    query: vi.fn(async (_vec: number[], _opts: unknown) => ({
      matches: [{ id: "v1", score: 0.9, metadata: { path: "src/a.ts" } }],
    })),
    deleteByIds: vi.fn(async (_ids: string[]) => ({ mutationId: "m2" })),
  };
}

/** A Workers-AI-shaped stub recording the run call. */
function aiStub() {
  return { run: vi.fn(async (_model: string, _opts: Record<string, unknown>) => ({ data: [[0.1, 0.2]] })) };
}

describe("createReviewAdapters: bundle assembly + graceful degradation", () => {
  it("builds all three adapters when every binding is present", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB, VECTORIZE: vectorizeStub(), AI: aiStub() } as unknown as Env);
    expect(infra.storage).toBeDefined();
    expect(infra.vector).toBeDefined();
    expect(infra.inference).toBeDefined();
  });

  it("carries the configured RAG vector dimension into the infra bundle", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB, VECTORIZE: vectorizeStub(), AI: aiStub(), QDRANT_DIM: "768" } as unknown as Env);
    expect(infra.embeddingDimensions).toBe(768);
  });

  it("carries the configured embed batch size into the infra bundle (self-host GPU tuning, #4327)", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB, VECTORIZE: vectorizeStub(), AI: aiStub(), AI_EMBED_BATCH: "32" } as unknown as Env);
    expect(infra.embedBatch).toBe(32);
  });

  it("prefers the dedicated AI_EMBED provider for inference, keeping the review chain frontier-only", async () => {
    const { DB } = dbStub();
    const reviewAi = { run: vi.fn(async () => ({ response: "review text" })) }; // would NOT return embed data
    const embedAi = { run: vi.fn(async () => ({ data: [[0.1, 0.2]] })) };
    const infra = createReviewAdapters({ DB, VECTORIZE: vectorizeStub(), AI: reviewAi, AI_EMBED: embedAi } as unknown as Env);
    // The embed call goes to AI_EMBED (ollama), never the review chain.
    await infra.inference!.run("bge-m3", { text: ["hi"] });
    expect(embedAi.run).toHaveBeenCalledTimes(1);
    expect(reviewAi.run).not.toHaveBeenCalled();
  });

  it("falls back to env.AI for inference when no dedicated AI_EMBED is configured (byte-identical to before)", async () => {
    const { DB } = dbStub();
    const ai = aiStub();
    const infra = createReviewAdapters({ DB, AI: ai } as unknown as Env);
    expect(infra.inference).toBeDefined();
    await infra.inference!.run("bge-m3", { text: ["hi"] });
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("degrades to no-RAG/no-context when VECTORIZE and AI are absent (storage always present, never throws)", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB } as unknown as Env);
    // Storage is always present — the Worker cannot run without D1.
    expect(infra.storage).toBeDefined();
    // Feature-gated bindings are OMITTED (undefined), the fail-safe shape the ported RAG helpers handle
    // ("no vector index → no RAG", "no AI → no context"). Critically, building the bundle never throws.
    expect(infra.vector).toBeUndefined();
    expect(infra.inference).toBeUndefined();
  });

  it("omits only the missing binding (vector present, inference absent)", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB, VECTORIZE: vectorizeStub() } as unknown as Env);
    expect(infra.vector).toBeDefined();
    expect(infra.inference).toBeUndefined();
  });

  it("respects exactOptionalPropertyTypes — absent members are absent keys, not `undefined` values", () => {
    const { DB } = dbStub();
    const infra = createReviewAdapters({ DB } as unknown as Env);
    expect("vector" in infra).toBe(false);
    expect("inference" in infra).toBe(false);
    expect("embeddingDimensions" in infra).toBe(false);
    expect("embedBatch" in infra).toBe(false);
  });
});

describe("reviewStorageAdapter: delegates to env.DB", () => {
  it("forwards prepare/bind/first/all/run + batch to the D1 binding", async () => {
    const { DB, calls, bound } = dbStub();
    const storage = reviewStorageAdapter({ DB } as unknown as Env);

    const stmt = storage.prepare("SELECT COUNT(*) AS n FROM repo_chunks WHERE project = ?").bind("p");
    expect(calls.prepare[0]).toContain("repo_chunks");
    expect(calls.bind[0]).toEqual(["p"]);

    expect(await stmt.first<{ n: number }>()).toEqual({ n: 7 });
    expect(await stmt.all<{ id: string; text: string }>()).toEqual({ results: [{ id: "a", text: "x" }] });
    await stmt.run();
    expect(bound.run).toHaveBeenCalled();

    await storage.batch([stmt]);
    expect(DB.batch).toHaveBeenCalledTimes(1);
  });
});

describe("reviewVectorAdapter: delegates to env.VECTORIZE", () => {
  it("forwards upsert and normalizes query matches to {id,score,metadata}", async () => {
    const vec = vectorizeStub();
    const adapter = reviewVectorAdapter(vec as unknown as Vectorize);

    await adapter.upsert([{ id: "v1", values: [0.1], namespace: "ns", metadata: { path: "a" } }]);
    expect(vec.upsert).toHaveBeenCalledTimes(1);

    const res = await adapter.query([0.1, 0.2], { topK: 5, namespace: "ns", returnMetadata: "all" });
    expect(vec.query).toHaveBeenCalledWith([0.1, 0.2], { topK: 5, namespace: "ns", returnMetadata: "all" });
    expect(res.matches).toEqual([{ id: "v1", score: 0.9, metadata: { path: "src/a.ts" } }]);

    await adapter.deleteByIds(["v1"]);
    expect(vec.deleteByIds).toHaveBeenCalledWith(["v1"]);
  });

  it("returns an empty match list when the binding yields no matches (no throw)", async () => {
    const vec = { ...vectorizeStub(), query: vi.fn(async () => ({ matches: undefined })) };
    const adapter = reviewVectorAdapter(vec as unknown as Vectorize);
    const res = await adapter.query([0.1], { topK: 3 });
    expect(res.matches).toEqual([]);
  });
});

describe("reviewInferenceAdapter: delegates to env.AI", () => {
  it("forwards run(model, options) to the AI binding and returns its result", async () => {
    const ai = aiStub();
    const env = createTestEnv({ AI: ai as unknown as Ai });
    const adapter = reviewInferenceAdapter(env, ai as unknown as Ai);
    const out = await adapter.run("@cf/baai/bge-m3", { text: ["hello"] });
    expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-m3", { text: ["hello"] });
    expect(out).toEqual({ data: [[0.1, 0.2]] });
  });

  it("records the embedding call under the `embeddings` feature, using the real reported provider/model (2026-07 fix)", async () => {
    const ai = { run: vi.fn(async () => ({ data: [[0.1, 0.2]], usage: { provider: "ollama", model: "bge-m3" } })) };
    const env = createTestEnv({ AI: ai as unknown as Ai });
    const adapter = reviewInferenceAdapter(env, ai as unknown as Ai);
    await adapter.run("@cf/baai/bge-m3", { text: ["hello"] });
    const row = await env.DB.prepare("select feature, model, provider, status from ai_usage_events order by rowid desc limit 1").first<{
      feature: string;
      model: string;
      provider: string | null;
      status: string;
    }>();
    expect(row).toMatchObject({ feature: "embeddings", model: "bge-m3", provider: "ollama", status: "ok" });
  });

  it("falls back to the requested model label when the provider reports no usage at all (e.g. the Workers AI binding)", async () => {
    const ai = aiStub();
    const env = createTestEnv({ AI: ai as unknown as Ai });
    const adapter = reviewInferenceAdapter(env, ai as unknown as Ai);
    await adapter.run("@cf/baai/bge-m3", { text: ["hello"] });
    const row = await env.DB.prepare("select feature, model, provider, status from ai_usage_events order by rowid desc limit 1").first<{
      feature: string;
      model: string;
      provider: string | null;
      status: string;
    }>();
    expect(row).toMatchObject({ feature: "embeddings", model: "@cf/baai/bge-m3", provider: null, status: "ok" });
  });

  it("records a failed embedding call and RETHROWS (the caller's own fail-safe still sees the error)", async () => {
    const ai = {
      run: vi.fn(async () => {
        throw new Error("embed_provider_unreachable");
      }),
    };
    const env = createTestEnv({ AI: ai as unknown as Ai });
    const adapter = reviewInferenceAdapter(env, ai as unknown as Ai);
    await expect(adapter.run("@cf/baai/bge-m3", { text: ["hello"] })).rejects.toThrow("embed_provider_unreachable");
    const row = await env.DB.prepare("select feature, model, status, detail from ai_usage_events order by rowid desc limit 1").first<{
      feature: string;
      model: string;
      status: string;
      detail: string | null;
    }>();
    expect(row).toMatchObject({ feature: "embeddings", model: "@cf/baai/bge-m3", status: "error", detail: "embed_provider_unreachable" });
  });

  it("records a failed embedding call with the literal fallback detail when the provider throws a non-Error value", async () => {
    const ai = {
      run: vi.fn(async () => {
        throw "not an Error instance";
      }),
    };
    const env = createTestEnv({ AI: ai as unknown as Ai });
    const adapter = reviewInferenceAdapter(env, ai as unknown as Ai);
    await expect(adapter.run("@cf/baai/bge-m3", { text: ["hello"] })).rejects.toBe("not an Error instance");
    const row = await env.DB.prepare("select feature, model, status, detail from ai_usage_events order by rowid desc limit 1").first<{
      feature: string;
      model: string;
      status: string;
      detail: string | null;
    }>();
    expect(row).toMatchObject({ feature: "embeddings", model: "@cf/baai/bge-m3", status: "error", detail: "embedding_failed" });
  });
});
