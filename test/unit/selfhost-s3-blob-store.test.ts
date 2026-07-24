import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createS3BlobStore } from "../../src/selfhost/s3-blob-store";

const CONFIG = {
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  bucket: "loopover-shots",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
};

describe("createS3BlobStore (self-host visual screenshot persistence, S3-compatible bucket)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("get: a successful response streams the object body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const store = createS3BlobStore(CONFIG);
    const object = await store.get("loopover/shots/abc.png");
    expect(object).not.toBeNull();
    expect(Array.from(new Uint8Array(await new Response(object!.body).arrayBuffer()))).toEqual([1, 2, 3]);

    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.url).toBe("https://abc123.r2.cloudflarestorage.com/loopover-shots/loopover/shots/abc.png");
    expect(request.method).toBe("GET");
  });

  it("get: a 404 response is a miss (returns null), not an error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await createS3BlobStore(CONFIG).get("loopover/shots/missing.png")).toBeNull();
  });

  it("get: a network failure degrades to null (never throws)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(createS3BlobStore(CONFIG).get("loopover/shots/x.png")).resolves.toBeNull();
  });

  it("put: a successful response returns the key and carries the content-type", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const store = createS3BlobStore(CONFIG);
    const result = await store.put("loopover/shots/new.png", new Uint8Array([9, 9]), { httpMetadata: { contentType: "image/png" } });
    expect(result.key).toBe("loopover/shots/new.png");

    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.url).toBe("https://abc123.r2.cloudflarestorage.com/loopover-shots/loopover/shots/new.png");
    expect(request.method).toBe("PUT");
    expect(request.headers.get("content-type")).toBe("image/png");
  });

  it("put: accepts a null value (stores an empty body), satisfying the R2 put body type", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createS3BlobStore(CONFIG).put("loopover/shots/empty.png", null);
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect((await request.arrayBuffer()).byteLength).toBe(0);
  });

  it("put: omitted httpMetadata sends no content-type header (both branches of the optional covered)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createS3BlobStore(CONFIG).put("loopover/shots/no-type.png", new Uint8Array([1]));
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.headers.get("content-type")).toBeNull();
  });

  it("put: a non-2xx response throws", async () => {
    fetchMock.mockResolvedValueOnce(new Response("access denied", { status: 403 }));
    await expect(createS3BlobStore(CONFIG).put("loopover/shots/x.png", new Uint8Array([1]))).rejects.toThrow(/S3 put failed: 403/);
  });

  it("delete: a successful response resolves", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(createS3BlobStore(CONFIG).delete("loopover/shots/x.png")).resolves.toBeUndefined();
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.method).toBe("DELETE");
  });

  it("delete: a 404 is treated as already-deleted (idempotent, matches R2/fs-store semantics), not an error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(createS3BlobStore(CONFIG).delete("loopover/shots/already-gone.png")).resolves.toBeUndefined();
  });

  it("delete: any other failure throws", async () => {
    // aws4fetch retries a 5xx internally (default up to 10x) before giving up -- mockResolvedValue (not
    // -Once) so every retry attempt sees the same persistent failure, matching a genuinely-down upstream.
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));
    await expect(createS3BlobStore(CONFIG).delete("loopover/shots/x.png")).rejects.toThrow(/S3 delete failed: 500/);
  });

  it("URL-encodes each key segment while preserving the / path structure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createS3BlobStore(CONFIG).put("loopover/shots/a b#c.png", new Uint8Array([1]));
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.url).toBe("https://abc123.r2.cloudflarestorage.com/loopover-shots/loopover/shots/a%20b%23c.png");
  });

  it("strips a trailing slash from the configured endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    await createS3BlobStore({ ...CONFIG, endpoint: `${CONFIG.endpoint}/` }).get("loopover/shots/x.png");
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.url).toBe("https://abc123.r2.cloudflarestorage.com/loopover-shots/loopover/shots/x.png");
  });

  it("defaults the SigV4 region to \"auto\" (R2's convention) when not configured", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    await createS3BlobStore(CONFIG).get("loopover/shots/x.png");
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.headers.get("authorization")).toContain("/auto/s3/aws4_request");
  });

  it("uses a configured region instead of the \"auto\" default when provided", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    await createS3BlobStore({ ...CONFIG, region: "us-east-1" }).get("loopover/shots/x.png");
    const [request] = fetchMock.mock.calls[0] as [Request];
    expect(request.headers.get("authorization")).toContain("/us-east-1/s3/aws4_request");
  });
});

describe("S3 REST calls are bounded by an AbortSignal timeout (#8362)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("get, put, and delete all pass an AbortSignal to the underlying fetch", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    const store = createS3BlobStore(CONFIG);
    await store.get("loopover/shots/x.png");
    await store.put("loopover/shots/x.png", new Uint8Array([1]));
    await store.delete("loopover/shots/x.png");

    expect(fetchMock.mock.calls.length).toBe(3);
    for (const call of fetchMock.mock.calls) {
      const [request] = call as [Request];
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("a get() request that aborts (simulating a timed-out fetch) degrades to null (never throws), matching the network-failure fail-safe", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "TimeoutError"));
    await expect(createS3BlobStore(CONFIG).get("loopover/shots/x.png")).resolves.toBeNull();
  });

  it("a put() request that aborts (simulating a timed-out fetch) rejects, matching the network-failure fail-safe contract of put/delete", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted.", "TimeoutError"));
    await expect(createS3BlobStore(CONFIG).put("loopover/shots/x.png", new Uint8Array([1]))).rejects.toThrow(/aborted/);
  });
});
