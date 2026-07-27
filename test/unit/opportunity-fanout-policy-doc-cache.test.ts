import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route the miner's bare "@loopover/engine" import at the engine source (mirrors
// opportunity-fanout-ai-policy.test.ts) so the fan-out uses the real resolveAiPolicyVerdict.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { fetchCandidateIssuesWithSummary } from "../../packages/loopover-miner/lib/opportunity-fanout";
import { initPolicyDocCacheStore } from "../../packages/loopover-miner/lib/policy-doc-cache";

const API = "https://api.test";
const AI_USAGE_URL = `${API}/repos/acme/widgets/contents/AI-USAGE.md`;

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");
const ALLOWED_AI_USAGE = readFileSync(join(fixtureDir, "allowed-encourages-ai.md"), "utf8");

type FetchCall = { url: string; headers: Record<string, string> };

function headerRecord(init?: RequestInit): Record<string, string> {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1800000000", ...(init.headers ?? {}) },
  });
}

function contentResponse(content: string, etag?: string) {
  const headers: Record<string, string> = etag === undefined ? {} : { etag };
  return jsonResponse(
    { type: "file", encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") },
    { headers },
  );
}

function notModifiedResponse() {
  return new Response(null, {
    status: 304,
    headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "1800000000" },
  });
}

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  labels: ["help wanted"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
});

/** A minimal in-memory PolicyDocCache that records its writes, so a test can assert exactly what got cached. */
function fakeCache(overrides: { getImpl?: (url: string) => unknown; putImpl?: () => void } = {}) {
  const store = new Map<string, { etag: string; content: string }>();
  const puts: Array<{ url: string; etag: string; content: string }> = [];
  return {
    store,
    puts,
    get(url: string) {
      if (overrides.getImpl) return overrides.getImpl(url);
      return store.get(url) ?? null;
    },
    put(url: string, etag: string, content: string) {
      if (overrides.putImpl) overrides.putImpl();
      store.set(url, { etag, content });
      puts.push({ url, etag, content });
      return { url, etag, content, updatedAt: "t" };
    },
  };
}

/** Stub global fetch, recording each call's URL + headers; policy doc served per `policy`, issues always one. */
function stubFetch(policy: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: FetchCall = { url, headers: headerRecord(init) };
    calls.push(call);
    if (url.includes("/contents/AI-USAGE.md")) return policy(call);
    if (url.includes("/repos/acme/widgets/issues?")) return jsonResponse([issue(1)]);
    return jsonResponse({}, { status: 404 });
  });
  return calls;
}

async function discover(policyDocCache: unknown) {
  return fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
    apiBaseUrl: API,
    // biome-ignore lint/suspicious/noExplicitAny: the injected fake satisfies the structural PolicyDocCache surface.
    policyDocCache: policyDocCache as any,
  });
}

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opportunity fan-out policy-doc conditional-GET cache (#4842)", () => {
  it("sends no conditional header on a cold cache and stores the fetched ETag", async () => {
    const cache = fakeCache();
    const calls = stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    const policyCall = calls.find((call) => call.url === AI_USAGE_URL);
    expect(policyCall?.headers["if-none-match"]).toBeUndefined();
    expect(cache.puts).toEqual([{ url: AI_USAGE_URL, etag: '"v1"', content: ALLOWED_AI_USAGE }]);
  });

  it("revalidates a cached doc with If-None-Match and serves the 304 body without re-downloading", async () => {
    const cache = fakeCache();
    cache.store.set(AI_USAGE_URL, { etag: '"v1"', content: ALLOWED_AI_USAGE });
    const calls = stubFetch(() => notModifiedResponse());

    const result = await discover(cache);

    // The policy resolved from the cached body (issue survives) even though the 304 carried no doc.
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    const policyCall = calls.find((call) => call.url === AI_USAGE_URL);
    expect(policyCall?.headers["if-none-match"]).toBe('"v1"');
    // A 304 revalidation never re-caches: the stored entry is untouched.
    expect(cache.puts).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("does not cache a 200 response that carries no ETag header", async () => {
    const cache = fakeCache();
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toEqual([]);
  });

  it("does not cache a blank ETag", async () => {
    const cache = fakeCache();
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, "   "));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toEqual([]);
  });

  it("does not cache when the response body has no decodable content", async () => {
    const cache = fakeCache();
    // AI-USAGE.md 200 with no `content` field decodes to null; policy falls through to a (404) CONTRIBUTING.md,
    // so both docs resolve to a silent allow and nothing is cached.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/AI-USAGE.md")) return jsonResponse({ type: "file" }, { headers: { etag: '"v1"' } });
      if (url.includes("/contents/CONTRIBUTING.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/repos/acme/widgets/issues?")) return jsonResponse([issue(1)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toEqual([]);
  });

  it("treats a cache read failure as a miss and still fetches the doc in full", async () => {
    const cache = fakeCache({
      getImpl: () => {
        throw new Error("corrupt cache");
      },
    });
    const calls = stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    const policyCall = calls.find((call) => call.url === AI_USAGE_URL);
    expect(policyCall?.headers["if-none-match"]).toBeUndefined();
    // The read failed but the write path still runs — a later run can revalidate.
    expect(cache.puts).toHaveLength(1);
  });

  it("never fails discovery when the cache write throws", async () => {
    const cache = fakeCache({
      putImpl: () => {
        throw new Error("disk full");
      },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(result.warnings).toEqual([]);
  });

  it("warns and caches nothing when the policy fetch returns a non-404 error", async () => {
    const cache = fakeCache();
    // A 403 is neither 304, 404, nor ok: fetchRepoDoc records a warning and returns null, so nothing is cached.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({ message: "forbidden" }, { status: 403 });
      if (url.includes("/repos/acme/widgets/issues?")) return jsonResponse([issue(1)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await discover(cache);

    expect(result.warnings.some((warning) => warning.stage.startsWith("policy:"))).toBe(true);
    expect(cache.puts).toEqual([]);
  });

  it("records a warning and caches nothing when the policy fetch itself throws", async () => {
    const cache = fakeCache();
    // A thrown fetch (network-level failure) is not retried; fetchRepoDoc catches it, warns, and returns null.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) throw new Error("socket hang up");
      if (url.includes("/repos/acme/widgets/issues?")) return jsonResponse([issue(1)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await discover(cache);

    expect(result.warnings.some((warning) => warning.message === "socket hang up")).toBe(true);
    expect(cache.puts).toEqual([]);
  });

  it("fetches normally when no cache is supplied (feature is inert without one)", async () => {
    const calls = stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    const policyCall = calls.find((call) => call.url === AI_USAGE_URL);
    expect(policyCall?.headers["if-none-match"]).toBeUndefined();
  });

  it("persists the ETag across two runs with the real on-disk store, then serves a 304", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-policy-doc-cache-fanout-"));
    roots.push(root);
    const dbPath = join(root, "policy-doc-cache.sqlite3");
    const store = initPolicyDocCacheStore(dbPath);
    stores.push(store);

    const firstCalls = stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));
    const first = await discover(store);
    expect(first.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(firstCalls.find((call) => call.url === AI_USAGE_URL)?.headers["if-none-match"]).toBeUndefined();
    expect(store.get(AI_USAGE_URL)).toEqual({ etag: '"v1"', content: ALLOWED_AI_USAGE });

    vi.unstubAllGlobals();
    const secondCalls = stubFetch(() => notModifiedResponse());
    const second = await discover(store);
    expect(second.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(secondCalls.find((call) => call.url === AI_USAGE_URL)?.headers["if-none-match"]).toBe('"v1"');

    // The ETag really landed on disk: a freshly reopened handle still has it.
    const reopened = initPolicyDocCacheStore(dbPath);
    stores.push(reopened);
    expect(reopened.get(AI_USAGE_URL)).toEqual({ etag: '"v1"', content: ALLOWED_AI_USAGE });
  });
});
