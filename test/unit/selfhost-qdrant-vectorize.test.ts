import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createQdrantVectorize, initQdrantCollection, qdrantDimensionFromEnv, qdrantReadyzUrl } from "../../src/selfhost/qdrant-vectorize";
import { resetMetrics, renderMetrics } from "../../src/selfhost/metrics";

const BASE = "http://qdrant:6333";

/** Build a fake fetch that returns the given response for any call. */
function mockFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function collectionInfo(size: number) {
  return { result: { config: { params: { vectors: { size } } } } };
}

describe("qdrantReadyzUrl (#1482 regression)", () => {
  it("points readiness probes at Qdrant's unauthenticated /readyz endpoint", () => {
    expect(qdrantReadyzUrl(BASE)).toBe(`${BASE}/readyz`);
    expect(qdrantReadyzUrl(`${BASE}/`)).toBe(`${BASE}/readyz`);
  });
});

describe("qdrantDimensionFromEnv", () => {
  it("uses a positive integer dimension from QDRANT_DIM", () => {
    expect(qdrantDimensionFromEnv("768")).toBe(768);
    expect(qdrantDimensionFromEnv("1536.9")).toBe(1536);
  });

  it("falls back to the bge-m3 default for unset, invalid, or non-positive values", () => {
    expect(qdrantDimensionFromEnv(undefined)).toBe(1024);
    expect(qdrantDimensionFromEnv("")).toBe(1024);
    expect(qdrantDimensionFromEnv("not-a-number")).toBe(1024);
    expect(qdrantDimensionFromEnv("0")).toBe(1024);
    expect(qdrantDimensionFromEnv("-5")).toBe(1024);
  });
});

describe("initQdrantCollection (#1217)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetMetrics();
    delete process.env.QDRANT_DIM;
  });

  it("PUTs to /collections/<name> with cosine + size params", async () => {
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    await initQdrantCollection(BASE);
    expect(fake).toHaveBeenCalledOnce();
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/collections/gittensory`);
    const body = JSON.parse(init.body as string) as { vectors: { size: number; distance: string } };
    expect(body.vectors.distance).toBe("Cosine");
    expect(body.vectors.size).toBe(1024);
  });

  it("accepts a 409 when the existing collection dimension matches", async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "exists" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(collectionInfo(1024)), { status: 200 }));
    vi.stubGlobal("fetch", fake);
    await expect(initQdrantCollection(BASE)).resolves.not.toThrow();
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls[1]?.[0]).toBe(`${BASE}/collections/gittensory`);
  });

  it("throws on a 409 when the existing collection dimension is wrong", async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "exists" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(collectionInfo(1024)), { status: 200 }));
    vi.stubGlobal("fetch", fake);
    await expect(initQdrantCollection(BASE, "gittensory", 768)).rejects.toThrow(/existing 1024, configured 768/);
  });

  it("throws when an existing collection cannot be inspected after a 409", async () => {
    const fake = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "exists" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    vi.stubGlobal("fetch", fake);
    await expect(initQdrantCollection(BASE)).rejects.toThrow(/lookup failed: HTTP 503/);
  });

  it("throws on any other non-OK status", async () => {
    vi.stubGlobal("fetch", mockFetch(500, { error: "server error" }));
    await expect(initQdrantCollection(BASE)).rejects.toThrow(/HTTP 500/);
  });

  it("uses a custom collection name and dimension when provided", async () => {
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    await initQdrantCollection(BASE, "custom-col", 768);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("custom-col");
    expect((JSON.parse(init.body as string) as { vectors: { size: number } }).vectors.size).toBe(768);
  });

  it("uses QDRANT_DIM as the default collection dimension when configured", async () => {
    process.env.QDRANT_DIM = "768";
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    await initQdrantCollection(BASE);
    const init = (fake.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((JSON.parse(init.body as string) as { vectors: { size: number } }).vectors.size).toBe(768);
  });
});

describe("initQdrantCollection — QDRANT_API_KEY header", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.QDRANT_API_KEY; });

  it("includes api-key header when QDRANT_API_KEY is set", async () => {
    process.env.QDRANT_API_KEY = "secret-key";
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    await initQdrantCollection(BASE);
    const init = (fake.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["api-key"]).toBe("secret-key");
  });

  it("omits api-key header when QDRANT_API_KEY is unset", async () => {
    delete process.env.QDRANT_API_KEY;
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    await initQdrantCollection(BASE);
    const init = (fake.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["api-key"]).toBeUndefined();
  });
});

describe("createQdrantVectorize (#1217 Qdrant adapter)", () => {
  beforeEach(() => { vi.restoreAllMocks(); resetMetrics(); });

  // ── upsert ────────────────────────────────────────────────────────────────

  it("upsert PUTs points with uuid-mapped IDs and payload including _orig_id + namespace", async () => {
    const fake = mockFetch(200, { status: "ok" });
    vi.stubGlobal("fetch", fake);
    const v = createQdrantVectorize(BASE);
    const result = await v.upsert([{ id: "repo/file:1", values: [0.1, 0.2], namespace: "ns1", metadata: { path: "a.ts" } }]);
    expect(result).toEqual({ count: 1, ids: ["repo/file:1"] });
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/points");
    const body = JSON.parse(init.body as string) as { points: Array<{ id: string; payload: { _orig_id: string; namespace: string } }> };
    expect(body.points[0]?.payload._orig_id).toBe("repo/file:1");
    expect(body.points[0]?.payload.namespace).toBe("ns1");
    // UUID must match the pattern xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(body.points[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("upsert defaults namespace to empty string when absent", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const v = createQdrantVectorize(BASE);
    await v.upsert([{ id: "no-ns", values: [1, 0] }]);
    const init = (vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { points: Array<{ payload: { namespace: string } }> };
    expect(body.points[0]?.payload.namespace).toBe("");
  });

  it("upsert throws on a non-OK response and increments error counter", async () => {
    vi.stubGlobal("fetch", mockFetch(503));
    const v = createQdrantVectorize(BASE);
    await expect(v.upsert([{ id: "x", values: [1] }])).rejects.toThrow(/HTTP 503/);
    expect(await renderMetrics()).toContain('gittensory_qdrant_errors_total{op="upsert"}');
  });

  it("successful upsert increments gittensory_qdrant_upserts_total by vector count", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const v = createQdrantVectorize(BASE);
    await v.upsert([{ id: "a", values: [1] }, { id: "b", values: [0] }]);
    const metrics = await renderMetrics();
    expect(metrics).toMatch(/gittensory_qdrant_upserts_total 2/);
  });

  it("same string ID always produces the same UUID (deterministic mapping)", async () => {
    vi.stubGlobal("fetch", mockFetch(200));
    const v = createQdrantVectorize(BASE);
    await v.upsert([{ id: "stable-id", values: [1] }]);
    const body1 = JSON.parse(((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body) as string) as { points: Array<{ id: string }> };
    vi.mocked(fetch).mockClear();
    await v.upsert([{ id: "stable-id", values: [1] }]);
    const body2 = JSON.parse(((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body) as string) as { points: Array<{ id: string }> };
    expect(body1.points[0]?.id).toBe(body2.points[0]?.id);
  });

  // ── query ─────────────────────────────────────────────────────────────────

  it("query POSTs a search request with namespace filter and returns matches with _orig_id restored", async () => {
    const qdrantResponse = {
      result: [{ id: "some-uuid", score: 0.92, payload: { _orig_id: "repo/f:1", namespace: "ns", path: "f.ts" } }],
    };
    vi.stubGlobal("fetch", mockFetch(200, qdrantResponse));
    const v = createQdrantVectorize(BASE);
    const { matches } = await v.query([0.5, 0.5], { topK: 5, namespace: "ns" });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe("repo/f:1"); // _orig_id restored
    expect(matches[0]?.score).toBeCloseTo(0.92);
    expect(matches[0]?.metadata?.path).toBe("f.ts");
    const init = (vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { filter?: { must: Array<{ key: string; match: { value: string } }> } };
    expect(body.filter?.must[0]?.key).toBe("namespace");
    expect(body.filter?.must[0]?.match.value).toBe("ns");
  });

  it("query without namespace sends no filter", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { result: [] }));
    const v = createQdrantVectorize(BASE);
    await v.query([1, 0], { topK: 10 });
    const body = JSON.parse(((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body) as string) as { filter?: unknown };
    expect(body.filter).toBeUndefined();
  });

  it("query defaults topK to 12 when omitted", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { result: [] }));
    const v = createQdrantVectorize(BASE);
    await v.query([1, 0], {});
    const body = JSON.parse(((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body) as string) as { limit: number };
    expect(body.limit).toBe(12);
  });

  it("query returns empty matches when Qdrant is unreachable (network error) and tracks error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const v = createQdrantVectorize(BASE);
    const { matches } = await v.query([1, 0], { topK: 5 });
    expect(matches).toEqual([]);
    expect(await renderMetrics()).toContain('gittensory_qdrant_errors_total{op="query"}');
  });

  it("query returns empty matches on non-OK HTTP response (graceful degrade) and tracks error", async () => {
    vi.stubGlobal("fetch", mockFetch(503));
    const v = createQdrantVectorize(BASE);
    const { matches } = await v.query([1, 0], { topK: 5 });
    expect(matches).toEqual([]);
    expect(await renderMetrics()).toContain('gittensory_qdrant_errors_total{op="query"}');
  });

  it("successful query increments gittensory_qdrant_queries_total", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { result: [] }));
    const v = createQdrantVectorize(BASE);
    await v.query([1], {});
    await v.query([0], {});
    expect(await renderMetrics()).toMatch(/gittensory_qdrant_queries_total 2/);
  });

  it("query returns match without metadata when payload has no extra fields", async () => {
    const qdrantResponse = {
      result: [{ id: "uuid-1", score: 0.8, payload: { _orig_id: "plain-id", namespace: "n" } }],
    };
    vi.stubGlobal("fetch", mockFetch(200, qdrantResponse));
    const v = createQdrantVectorize(BASE);
    const { matches } = await v.query([1], {});
    expect(matches[0]).toEqual({ id: "plain-id", score: 0.8 });
    expect(matches[0]?.metadata).toBeUndefined();
  });

  it("query falls back to the Qdrant UUID when _orig_id is missing from payload", async () => {
    const qdrantResponse = {
      result: [{ id: "fallback-uuid", score: 0.5, payload: { namespace: "n" } }],
    };
    vi.stubGlobal("fetch", mockFetch(200, qdrantResponse));
    const v = createQdrantVectorize(BASE);
    const { matches } = await v.query([1], {});
    expect(matches[0]?.id).toBe("fallback-uuid");
  });

  // ── deleteByIds ───────────────────────────────────────────────────────────

  it("deleteByIds POSTs the uuid-mapped IDs and returns the count", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { status: "ok" }));
    const v = createQdrantVectorize(BASE);
    const result = await v.deleteByIds(["id-1", "id-2"]);
    expect(result).toEqual({ count: 2 });
    const init = (vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { points: string[] };
    expect(body.points).toHaveLength(2);
    body.points.forEach((p) => expect(p).toMatch(/^[0-9a-f]{8}-/));
  });

  it("deleteByIds is a no-op for an empty array (no fetch call)", async () => {
    const fake = mockFetch(200);
    vi.stubGlobal("fetch", fake);
    const v = createQdrantVectorize(BASE);
    const result = await v.deleteByIds([]);
    expect(result).toEqual({ count: 0 });
    expect(fake).not.toHaveBeenCalled();
  });

  it("deleteByIds throws on a non-OK response and tracks error", async () => {
    vi.stubGlobal("fetch", mockFetch(400));
    const v = createQdrantVectorize(BASE);
    await expect(v.deleteByIds(["id"])).rejects.toThrow(/HTTP 400/);
    expect(await renderMetrics()).toContain('gittensory_qdrant_errors_total{op="delete"}');
  });

  it("trailing slash in URL is stripped", async () => {
    const fake = mockFetch(200, { result: [] });
    vi.stubGlobal("fetch", fake);
    const v = createQdrantVectorize("http://qdrant:6333/");
    await v.query([1], {});
    const [url] = fake.mock.calls[0] as unknown as [string];
    expect(url).not.toContain("//collections");
  });
});
