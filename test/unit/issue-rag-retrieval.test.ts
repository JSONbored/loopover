import { afterEach, describe, expect, it, vi } from "vitest";
import * as ragModule from "../../src/review/rag";
import { RAG_DIMENSIONS } from "../../src/review/rag";
import {
  emptyIssueRagTelemetry,
  normalizeIssueRagTopK,
  retrieveIssueRagContext,
} from "../../src/review/issue-rag-retrieval";
import { createTestEnv } from "../helpers/d1";

const VEC_1024 = Array.from({ length: RAG_DIMENSIONS }, () => 0.01);

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

function vectorizeStub(matches = [{ id: "v1", score: 0.92, metadata: { path: "src/helper.ts" } }]) {
  return {
    upsert: vi.fn(async () => ({ mutationId: "m1" })),
    query: vi.fn(async () => ({ matches })),
    deleteByIds: vi.fn(async () => ({ mutationId: "m2" })),
  };
}

function aiStub() {
  return {
    run: vi.fn(async (model: string) => (model === "@cf/baai/bge-m3" ? { data: [VEC_1024] } : { response: "{}" })),
  };
}

describe("issue-centric RAG retrieval (#4293)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes topK to the hosted retrieval bounds", () => {
    expect(normalizeIssueRagTopK(undefined)).toBe(12);
    expect(normalizeIssueRagTopK(0)).toBe(1);
    expect(normalizeIssueRagTopK(4.9)).toBe(4);
    expect(normalizeIssueRagTopK(99)).toBe(12);
  });

  it("returns empty telemetry for a query below the retrieval floor", async () => {
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await retrieveIssueRagContext(env, {
      repoFullName: "acme/widgets",
      title: "Tiny",
    });
    expect(out.telemetry).toEqual(emptyIssueRagTelemetry());
  });

  it("returns metadata-only paths when retrieval succeeds", async () => {
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await retrieveIssueRagContext(env, {
      repoFullName: "acme/widgets",
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
      labels: ["selfhost"],
    });
    expect(out.repoFullName).toBe("acme/widgets");
    expect(out.telemetry.attempted).toBe(true);
    expect(out.telemetry.injected).toBe(true);
    expect(out.telemetry.retrievedPaths).toEqual(["src/helper.ts"]);
    expect(out.telemetry.retrievedPathCount).toBe(1);
  });

  it("degrades to empty telemetry when Vectorize/AI bindings are missing", async () => {
    const env = createTestEnv();
    const out = await retrieveIssueRagContext(env, {
      repoFullName: "acme/widgets",
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
    });
    expect(out.telemetry).toEqual(emptyIssueRagTelemetry());
  });

  it("passes review parity knobs into retrieveContextWithMetrics", async () => {
    const spy = vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "=== RELEVANT EXISTING CODE / DOCS ===",
      metrics: {
        candidates: 1,
        kept: 1,
        topScore: 0.9,
        minScore: 0.4,
        reranked: true,
        injectedChars: 120,
        paths: ["src/helper.ts"],
      },
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await retrieveIssueRagContext(env, {
      repoFullName: "acme/widgets",
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
      reranker: "off",
      topK: 6,
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      minScore: 0.4,
      reranker: "off",
      topK: 6,
      project: "acme",
      repo: "widgets",
    });
  });

  it("marks injected false when retrieval keeps zero paths", async () => {
    vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "",
      metrics: {
        candidates: 2,
        kept: 0,
        topScore: 0.2,
        minScore: 0.4,
        reranked: true,
        injectedChars: 0,
        paths: [],
      },
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    const out = await retrieveIssueRagContext(env, {
      repoFullName: "acme/widgets",
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
    });
    expect(out.telemetry.attempted).toBe(true);
    expect(out.telemetry.injected).toBe(false);
    expect(out.telemetry.retrievedPaths).toEqual([]);
  });

  it("handles slashless repo names by using an empty project namespace", async () => {
    const spy = vi.spyOn(ragModule, "retrieveContextWithMetrics").mockResolvedValue({
      context: "",
      metrics: {
        candidates: 0,
        kept: 0,
        topScore: 0,
        minScore: 0.4,
        reranked: false,
        injectedChars: 0,
        paths: [],
      },
    });
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await retrieveIssueRagContext(env, {
      repoFullName: "widgets",
      title: "Improve SQLite backup readiness checks",
      body: "Operators need restore guidance tied to the existing self-host backup flow.",
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ project: "", repo: "widgets" });
  });

  it("fail-safe: retrieval errors degrade to empty telemetry without throwing", async () => {
    vi.spyOn(ragModule, "retrieveContextWithMetrics").mockRejectedValue(new Error("vectorize down"));
    const env = createTestEnv({ DB: ragDbStub(), VECTORIZE: vectorizeStub() as unknown as Vectorize, AI: aiStub() as unknown as Ai });
    await expect(
      retrieveIssueRagContext(env, {
        repoFullName: "acme/widgets",
        title: "Improve SQLite backup readiness checks",
        body: "Operators need restore guidance tied to the existing self-host backup flow.",
      }),
    ).resolves.toMatchObject({ telemetry: emptyIssueRagTelemetry() });
  });
});
