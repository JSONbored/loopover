import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGitHubResponseCacheForTest } from "../../src/github/client";
import { sha256Hex } from "../../src/utils/crypto";
import { createTestEnv } from "../helpers/d1";
import {
  clearFallbackDispatchMarker,
  dispatchVisualCaptureFallback,
  fallbackShotFileName,
  fallbackShotR2Key,
  fetchFallbackArtifactShots,
  FALLBACK_ARTIFACT_NAME,
  isFallbackDispatchInFlight,
  isGithubArtifactStorageUrl,
  markFallbackDispatched,
  parseFallbackRunCorrelation,
  parseZipEntries,
  slugifyRoutePath,
} from "../../src/review/visual/actions-fallback";

/** A minimal in-memory R2Bucket for the dispatch-marker tests -- get/put/delete only, with optional
 *  per-operation failure injection, mirroring visual-capture.test.ts's own memoryReviewAudit() pattern. */
function memoryFallbackMarkerStore(options: { failGet?: boolean; failPut?: boolean; failDelete?: boolean } = {}): R2Bucket {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      if (options.failGet) throw new Error("simulated marker read failure");
      const value = store.get(key);
      return value === undefined ? null : ({ body: new Response(value).body } as unknown as R2ObjectBody);
    },
    async put(key: string, value: unknown) {
      if (options.failPut) throw new Error("simulated marker write failure");
      store.set(key, await new Response(value as BodyInit).text());
      return { key } as unknown as R2Object;
    },
    async delete(key: string) {
      if (options.failDelete) throw new Error("simulated marker delete failure");
      store.delete(key);
    },
  } as unknown as R2Bucket;
}

afterEach(() => {
  clearGitHubResponseCacheForTest();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------
// Minimal ZIP fixture builder -- constructs a real, spec-compliant archive for the reader tests below (a
// central directory + one local header per entry + an EOCD record), so parseZipEntries is exercised against
// actual zip bytes rather than a hand-approximated shape.
// ---------------------------------------------------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngBytes(label: string): Uint8Array {
  return concatBytes([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new TextEncoder().encode(label)]);
}

function buildZip(files: Array<{ name: string; data: Uint8Array; method: 0 | 8 }>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const compressed = file.method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(file.data))) : file.data;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(8, file.method, true);
    localHeader.setUint32(18, compressed.length, true);
    localHeader.setUint32(22, file.data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    const localEntry = concatBytes([new Uint8Array(localHeader.buffer), nameBytes, compressed]);
    localParts.push(localEntry);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(10, file.method, true);
    centralHeader.setUint32(20, compressed.length, true);
    centralHeader.setUint32(24, file.data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint32(42, offset, true);
    centralParts.push(concatBytes([new Uint8Array(centralHeader.buffer), nameBytes]));

    offset += localEntry.length;
  }
  const centralDirOffset = offset;
  const centralDirBytes = concatBytes(centralParts);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralDirBytes.length, true);
  eocd.setUint32(16, centralDirOffset, true);
  return concatBytes([...localParts, centralDirBytes, new Uint8Array(eocd.buffer)]);
}

// ---------------------------------------------------------------------------------------------------------

describe("isGithubArtifactStorageUrl (SSRF allowlist extension)", () => {
  it("allows an actions.githubusercontent.com download url", () => {
    expect(isGithubArtifactStorageUrl("https://pipelines.actions.githubusercontent.com/abc123")).toBe(true);
  });

  it("allows a blob.core.windows.net download url", () => {
    expect(isGithubArtifactStorageUrl("https://productionresultssa12.blob.core.windows.net/artifacts/x.zip")).toBe(true);
  });

  it("rejects a non-https url", () => {
    expect(isGithubArtifactStorageUrl("http://pipelines.actions.githubusercontent.com/abc123")).toBe(false);
  });

  it("rejects a private/loopback host even with the right-looking path", () => {
    expect(isGithubArtifactStorageUrl("https://127.0.0.1/blob.core.windows.net")).toBe(false);
  });

  it("rejects an unrelated public host", () => {
    expect(isGithubArtifactStorageUrl("https://evil.example.com/actions.githubusercontent.com")).toBe(false);
  });

  it("rejects an unparseable url", () => {
    expect(isGithubArtifactStorageUrl("not-a-url")).toBe(false);
  });
});

describe("parseFallbackRunCorrelation", () => {
  it("parses a matching run-name display_title", () => {
    expect(parseFallbackRunCorrelation("gittensory-visual-fallback pr=42 sha=0123456789abcdef0123456789abcdef01234567")).toEqual({
      prNumber: 42,
      headSha: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("lowercases an upper-case sha", () => {
    expect(parseFallbackRunCorrelation("gittensory-visual-fallback pr=1 sha=ABCDEF0123456789ABCDEF0123456789ABCDEF01")?.headSha).toBe(
      "abcdef0123456789abcdef0123456789abcdef01",
    );
  });

  it("returns null for an unrelated title", () => {
    expect(parseFallbackRunCorrelation("Some other workflow run")).toBeNull();
  });

  it("returns null for a null/undefined title", () => {
    expect(parseFallbackRunCorrelation(undefined)).toBeNull();
    expect(parseFallbackRunCorrelation(null)).toBeNull();
  });

  it("returns null for an empty-string title", () => {
    expect(parseFallbackRunCorrelation("")).toBeNull();
  });

  it("returns null when the pr number is not a positive integer", () => {
    expect(parseFallbackRunCorrelation("gittensory-visual-fallback pr=0 sha=0123456789abcdef0123456789abcdef01234567")).toBeNull();
  });
});

describe("slugifyRoutePath / fallbackShotFileName", () => {
  it("slugifies the root route to 'root'", () => {
    expect(slugifyRoutePath("/")).toBe("root");
  });

  it("slugifies a nested route", () => {
    expect(slugifyRoutePath("/app/analytics")).toBe("app-analytics");
  });

  it("collapses non-alphanumeric runs and strips leading/trailing dashes", () => {
    expect(slugifyRoutePath("/Pricing & Plans/")).toBe("pricing-plans");
  });

  it("builds the expected artifact filename per viewport", () => {
    expect(fallbackShotFileName("/", "desktop")).toBe("root--desktop.png");
    expect(fallbackShotFileName("/app/analytics", "mobile")).toBe("app-analytics--mobile.png");
  });
});

describe("fallbackShotR2Key", () => {
  it("is deterministic for the same (headSha, path, viewport)", async () => {
    const a = await fallbackShotR2Key("deadbeef", "/pricing", "desktop");
    const b = await fallbackShotR2Key("deadbeef", "/pricing", "desktop");
    expect(a).toBe(b);
    expect(a.startsWith("loopover/shots/actions-fallback/")).toBe(true);
    expect(a.endsWith(".png")).toBe(true);
  });

  it("differs across headSha, path, and viewport", async () => {
    const base = await fallbackShotR2Key("deadbeef", "/pricing", "desktop");
    expect(await fallbackShotR2Key("cafebabe", "/pricing", "desktop")).not.toBe(base);
    expect(await fallbackShotR2Key("deadbeef", "/docs", "desktop")).not.toBe(base);
    expect(await fallbackShotR2Key("deadbeef", "/pricing", "mobile")).not.toBe(base);
  });
});

describe("parseZipEntries", () => {
  it("extracts a STORED (uncompressed) entry", async () => {
    const data = new TextEncoder().encode("stored-bytes");
    const zip = buildZip([{ name: "root--desktop.png", data, method: 0 }]);
    const entries = await parseZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("root--desktop.png");
    expect(new TextDecoder().decode(entries[0]?.data)).toBe("stored-bytes");
  });

  it("extracts a DEFLATE-compressed entry", async () => {
    const data = new TextEncoder().encode("deflate-me-please".repeat(20));
    const zip = buildZip([{ name: "root--mobile.png", data, method: 8 }]);
    const entries = await parseZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode(entries[0]?.data)).toBe(new TextDecoder().decode(data));
  });

  it("extracts multiple entries in order", async () => {
    const zip = buildZip([
      { name: "a.png", data: new TextEncoder().encode("A"), method: 0 },
      { name: "b.png", data: new TextEncoder().encode("BB"), method: 8 },
    ]);
    const entries = await parseZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["a.png", "b.png"]);
  });

  it("returns [] for a buffer too small to contain an EOCD record", async () => {
    expect(await parseZipEntries(new Uint8Array(4))).toEqual([]);
  });

  it("returns [] when no EOCD signature is present", async () => {
    expect(await parseZipEntries(new Uint8Array(64))).toEqual([]);
  });

  // The next several tests patch specific fields of a real, valid single-entry zip to exercise each of
  // parseZipEntries' bounds/signature guards individually -- every one degrades to "stop reading" rather
  // than throwing, since this parses a REMOTE, only-indirectly-trusted byte stream.
  function singleEntryZipOffsets(zip: Uint8Array, nameLen: number, dataLen: number) {
    const localEntryLen = 30 + nameLen + dataLen;
    const centralDirStart = localEntryLen;
    const centralDirLen = 46 + nameLen;
    const eocdStart = centralDirStart + centralDirLen;
    return { view: new DataView(zip.buffer, zip.byteOffset, zip.byteLength), centralDirStart, eocdStart };
  }

  function viewCompressedSize(zip: Uint8Array): number {
    return new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(18, true);
  }

  it("stops reading once a corrupted entry count walks the central directory past the buffer end", async () => {
    const zip = buildZip([{ name: "a.png", data: new TextEncoder().encode("A"), method: 0 }]);
    const { view, eocdStart } = singleEntryZipOffsets(zip, "a.png".length, 1);
    view.setUint16(eocdStart + 10, 2, true); // claim 2 entries when only 1 exists
    const entries = await parseZipEntries(zip);
    expect(entries).toEqual([{ name: "a.png", data: new TextEncoder().encode("A") }]);
  });

  it("stops reading when the central directory offset does not point at a central-directory signature", async () => {
    const zip = buildZip([{ name: "a.png", data: new TextEncoder().encode("A"), method: 0 }]);
    const { view, eocdStart } = singleEntryZipOffsets(zip, "a.png".length, 1);
    view.setUint32(eocdStart + 16, 0, true); // point at the local-file-header region instead
    expect(await parseZipEntries(zip)).toEqual([]);
  });

  it("stops reading when a central-directory entry's name would run past the buffer end", async () => {
    const zip = buildZip([{ name: "a.png", data: new TextEncoder().encode("A"), method: 0 }]);
    const { view, centralDirStart } = singleEntryZipOffsets(zip, "a.png".length, 1);
    view.setUint16(centralDirStart + 28, 60000, true); // nameLen far beyond the buffer
    expect(await parseZipEntries(zip)).toEqual([]);
  });

  it("skips an entry whose local-header offset does not point at a local-file signature", async () => {
    const zip = buildZip([{ name: "a.png", data: new TextEncoder().encode("A"), method: 0 }]);
    const { view, centralDirStart } = singleEntryZipOffsets(zip, "a.png".length, 1);
    view.setUint32(centralDirStart + 42, centralDirStart, true); // points at the central-dir signature instead
    expect(await parseZipEntries(zip)).toEqual([]);
  });

  it("skips an entry whose declared compressed size would run past the buffer end", async () => {
    const zip = buildZip([{ name: "a.png", data: new TextEncoder().encode("A"), method: 0 }]);
    const { view, centralDirStart } = singleEntryZipOffsets(zip, "a.png".length, 1);
    view.setUint32(centralDirStart + 20, 999_999, true); // compressedSize far beyond the buffer
    expect(await parseZipEntries(zip)).toEqual([]);
  });

  it("skips (does not throw on) an entry whose declared DEFLATE bytes are not valid deflate data", async () => {
    // Build a normal method=8 entry, then corrupt its compressed payload so DecompressionStream rejects it --
    // the entry must be silently dropped, not surface as a thrown error.
    const zip = buildZip([{ name: "corrupt.png", data: new TextEncoder().encode("hello-world-hello-world"), method: 8 }]);
    const localHeaderView = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const nameLen = localHeaderView.getUint16(26, true);
    const compressedSize = localHeaderView.getUint32(18, true);
    const dataOffset = 30 + nameLen;
    // Flip only the compressed payload bytes (never the trailing central directory / EOCD) -- garbage input
    // DecompressionStream("deflate-raw") cannot parse.
    for (let i = dataOffset; i < dataOffset + compressedSize; i++) zip[i] = 0xff;
    const entries = await parseZipEntries(zip);
    expect(entries).toEqual([]);
  });

  it("returns [] for an unsupported compression method", async () => {
    // method 99 doesn't exist in the zip spec; parseZipEntries must skip it rather than throw.
    const zip = buildZip([{ name: "x.png", data: new TextEncoder().encode("x"), method: 0 }]);
    // Corrupt the central directory's compression-method field (offset 10 within the central header, which
    // starts right after the local entry).
    const localEntryLen = 30 + "x.png".length + 1;
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint16(localEntryLen + 10, 99, true);
    const entries = await parseZipEntries(zip);
    expect(entries).toEqual([]);
  });

  it("skips a ZIP entry whose declared uncompressed size exceeds the configured cap", async () => {
    const zip = buildZip([{ name: "big.png", data: new TextEncoder().encode("tiny"), method: 8 }]);
    const { view, centralDirStart } = singleEntryZipOffsets(zip, "big.png".length, viewCompressedSize(zip));
    view.setUint32(centralDirStart + 24, 9, true);
    await expect(parseZipEntries(zip, { maxEntryBytes: 8 })).resolves.toEqual([]);
  });

  it("stops inflating a DEFLATE entry once the output exceeds the configured cap", async () => {
    const zip = buildZip([{ name: "bomb.png", data: new TextEncoder().encode("A".repeat(4096)), method: 8 }]);
    await expect(parseZipEntries(zip, { maxEntryBytes: 1024 })).resolves.toEqual([]);
  });
});

describe("dispatchVisualCaptureFallback", () => {
  it("returns true on a successful (204) dispatch", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(null, { status: 204 });
    });
    const ok = await dispatchVisualCaptureFallback({
      token: "tok",
      repo: { owner: "acme", repo: "widgets" },
      ref: "main",
      prNumber: 7,
      headSha: "deadbeef",
      routes: ["/", "/pricing"],
    });
    expect(ok).toBe(true);
    expect(capturedUrl).toBe("https://api.github.com/repos/acme/widgets/actions/workflows/visual-capture-fallback.yml/dispatches");
    expect(capturedBody).toEqual({
      ref: "main",
      inputs: { pr_number: "7", head_sha: "deadbeef", routes: JSON.stringify(["/", "/pricing"]) },
    });
  });

  it("dispatches successfully when a rateLimitAdmissionKey is supplied", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    const ok = await dispatchVisualCaptureFallback({
      token: "tok",
      repo: { owner: "acme", repo: "widgets" },
      ref: "main",
      prNumber: 7,
      headSha: "deadbeef",
      routes: ["/"],
      rateLimitAdmissionKey: "installation:1",
    });
    expect(ok).toBe(true);
  });

  it("returns false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 422 }));
    const ok = await dispatchVisualCaptureFallback({
      token: "tok",
      repo: { owner: "acme", repo: "widgets" },
      ref: "main",
      prNumber: 7,
      headSha: "deadbeef",
      routes: ["/"],
    });
    expect(ok).toBe(false);
  });

  it("returns false (never throws) on a network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const ok = await dispatchVisualCaptureFallback({
      token: "tok",
      repo: { owner: "acme", repo: "widgets" },
      ref: "main",
      prNumber: 7,
      headSha: "deadbeef",
      routes: ["/"],
    });
    expect(ok).toBe(false);
  });
});

describe("isFallbackDispatchInFlight / markFallbackDispatched / clearFallbackDispatchMarker (#4112 review fix -- persisted R2 sentinel, avoid cancel-in-progress re-dispatch)", () => {
  const HEAD_SHA = "cafebabecafebabecafebabecafebabecafebabe";

  it("false when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv();
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("false when no marker has ever been written", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore() });
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("true immediately after markFallbackDispatched", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore() });
    await markFallbackDispatched(env, HEAD_SHA);
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(true);
  });

  it("false once the marker is older than the max age (abandoned dispatch)", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore() });
    vi.useFakeTimers();
    try {
      await markFallbackDispatched(env, HEAD_SHA);
      vi.advanceTimersByTime(19 * 60 * 1000); // past the 18-minute max age
      await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("false when the stored marker isn't valid JSON at all (caught by the outer try/catch)", async () => {
    const store = memoryFallbackMarkerStore();
    const env = createTestEnv({ REVIEW_AUDIT: store });
    const fingerprint = await sha256Hex(`${HEAD_SHA}:actions-fallback:dispatch-marker`);
    const key = `loopover/fallback-dispatch/${fingerprint.slice(0, 40)}.json`;
    await store.put(key, "not json");
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("false when the stored marker parses as JSON but is missing dispatchedAt (the explicit shape check, not the catch)", async () => {
    const store = memoryFallbackMarkerStore();
    const env = createTestEnv({ REVIEW_AUDIT: store });
    const fingerprint = await sha256Hex(`${HEAD_SHA}:actions-fallback:dispatch-marker`);
    const key = `loopover/fallback-dispatch/${fingerprint.slice(0, 40)}.json`;
    await store.put(key, JSON.stringify({ someOtherField: true }));
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("false (never throws) when the R2 read itself fails", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore({ failGet: true }) });
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("markFallbackDispatched never throws when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv();
    await expect(markFallbackDispatched(env, HEAD_SHA)).resolves.toBeUndefined();
  });

  it("markFallbackDispatched never throws (best-effort) when the R2 write itself fails", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore({ failPut: true }) });
    await expect(markFallbackDispatched(env, HEAD_SHA)).resolves.toBeUndefined();
  });

  it("clearFallbackDispatchMarker makes a subsequent isFallbackDispatchInFlight call false again", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore() });
    await markFallbackDispatched(env, HEAD_SHA);
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(true);
    await clearFallbackDispatchMarker(env, HEAD_SHA);
    await expect(isFallbackDispatchInFlight(env, HEAD_SHA)).resolves.toBe(false);
  });

  it("clearFallbackDispatchMarker never throws when REVIEW_AUDIT isn't configured", async () => {
    const env = createTestEnv();
    await expect(clearFallbackDispatchMarker(env, HEAD_SHA)).resolves.toBeUndefined();
  });

  it("clearFallbackDispatchMarker never throws (best-effort) when the R2 delete itself fails", async () => {
    const env = createTestEnv({ REVIEW_AUDIT: memoryFallbackMarkerStore({ failDelete: true }) });
    await expect(clearFallbackDispatchMarker(env, HEAD_SHA)).resolves.toBeUndefined();
  });
});

describe("fetchFallbackArtifactShots", () => {
  function stubSequence(handlers: Array<(input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>>): void {
    let call = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const handler = handlers[Math.min(call, handlers.length - 1)];
      call += 1;
      return handler ? handler(input, init) : new Response("unexpected", { status: 500 });
    });
  }

  it("lists, downloads, validates, and extracts PNG shots end to end", async () => {
    const zip = buildZip([
      { name: "root--desktop.png", data: pngBytes("desktop-bytes"), method: 0 },
      { name: "root--mobile.png", data: pngBytes("mobile-bytes"), method: 8 },
      { name: "manifest.json", data: new TextEncoder().encode("{}"), method: 0 },
    ]);
    stubSequence([
      () => Response.json({ artifacts: [{ id: 99, name: FALLBACK_ARTIFACT_NAME, expired: false, size_in_bytes: 1000 }] }),
      () => new Response(null, { status: 302, headers: { location: "https://productionresultssa1.blob.core.windows.net/x.zip" } }),
      () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
    ]);

    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 555 });
    expect(shots.map((s) => s.fileName).sort()).toEqual(["root--desktop.png", "root--mobile.png"]);
  });

  it("passes a rateLimitAdmissionKey through to the list-artifacts read without changing the result", async () => {
    stubSequence([() => Response.json({ artifacts: [{ id: 1, name: "some-other-artifact" }] })]);
    const shots = await fetchFallbackArtifactShots({
      token: "tok",
      repo: { owner: "acme", repo: "widgets" },
      runId: 1,
      rateLimitAdmissionKey: "installation:1",
    });
    expect(shots).toEqual([]);
  });

  it("returns [] when the run has no matching artifact", async () => {
    stubSequence([() => Response.json({ artifacts: [{ id: 1, name: "some-other-artifact" }] })]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the artifact is expired", async () => {
    stubSequence([() => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME, expired: true }] })]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the reported artifact size exceeds the cap", async () => {
    stubSequence([() => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME, size_in_bytes: 999_999_999 }] })]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the list-artifacts response body is not valid JSON", async () => {
    stubSequence([() => new Response("not-json{{{", { status: 200 })]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the list-artifacts call itself fails", async () => {
    stubSequence([() => new Response("nope", { status: 500 })]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("rejects a download redirect that does not point at an allowlisted artifact-storage host", async () => {
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal.zip" } }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the redirect carries no location header", async () => {
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302 }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the validated blob fetch itself fails", async () => {
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/x.zip" } }),
      () => new Response("nope", { status: 500 }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] when the downloaded blob exceeds the byte cap", async () => {
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/x.zip" } }),
      () => new Response(new Uint8Array(61 * 1024 * 1024), { status: 200 }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("returns [] (never throws) on a network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("ignores .png entries whose decompressed bytes do not have a PNG signature", async () => {
    const zip = buildZip([{ name: "root--desktop.png", data: new TextEncoder().encode("not really a png"), method: 0 }]);
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/x.zip" } }),
      () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots).toEqual([]);
  });

  it("caps the number of returned shots even when the artifact holds more PNGs than the limit", async () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      name: `route-${i}--desktop.png`,
      data: pngBytes(`shot-${i}`),
      method: 0 as const,
    }));
    const zip = buildZip(files);
    stubSequence([
      () => Response.json({ artifacts: [{ id: 1, name: FALLBACK_ARTIFACT_NAME }] }),
      () => new Response(null, { status: 302, headers: { location: "https://pipelines.actions.githubusercontent.com/x.zip" } }),
      () => new Response(zip.buffer as ArrayBuffer, { status: 200 }),
    ]);
    const shots = await fetchFallbackArtifactShots({ token: "tok", repo: { owner: "acme", repo: "widgets" }, runId: 1 });
    expect(shots.length).toBeLessThanOrEqual(24);
  });
});
