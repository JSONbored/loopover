import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route the miner's bare "@jsonbored/gittensory-engine" import at the engine source (mirrors
// opportunity-fanout-ai-policy.test.ts) so the fan-out uses the real resolveAiPolicyVerdict.
vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { fetchCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-fanout.js";
import { initPolicyVerdictCacheStore } from "../../packages/gittensory-miner/lib/policy-verdict-cache.js";

const API = "https://api.test";
const AI_USAGE_URL = `${API}/repos/acme/widgets/contents/AI-USAGE.md`;
const CONTRIBUTING_URL = `${API}/repos/acme/widgets/contents/CONTRIBUTING.md`;
const REPO = "acme/widgets";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");
const ALLOWED_AI_USAGE = readFileSync(join(fixtureDir, "allowed-encourages-ai.md"), "utf8");

type FetchCall = { url: string; headers: Record<string, string> };

function headerRecord(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
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

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  labels: ["help wanted"],
  comments: 1,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
});

/** A minimal in-memory PolicyVerdictCache that records its writes, so a test can assert exactly what got cached. */
function fakeVerdictCache(
  overrides: { getImpl?: (repoFullName: string) => unknown; putImpl?: () => void } = {},
) {
  const store = new Map<string, { decisiveDoc: string; etag: string; verdict: unknown }>();
  const puts: Array<{ repoFullName: string; decisiveDoc: string; etag: string; verdict: unknown }> = [];
  return {
    store,
    puts,
    get(repoFullName: string) {
      if (overrides.getImpl) return overrides.getImpl(repoFullName);
      return store.get(repoFullName) ?? null;
    },
    put(repoFullName: string, decisiveDoc: string, etag: string, verdict: unknown) {
      if (overrides.putImpl) overrides.putImpl();
      const entry = { decisiveDoc, etag, verdict };
      store.set(repoFullName, entry);
      puts.push({ repoFullName, decisiveDoc, etag, verdict });
      return { repoFullName, ...entry, updatedAt: "t" };
    },
  };
}

/** Stub global fetch: AI-USAGE.md served per `aiUsagePolicy`, CONTRIBUTING.md per `contributingPolicy` (defaults to
 * 404, matching most tests that only care about the AI-USAGE.md-decisive path). */
function stubFetch(
  aiUsagePolicy: (call: FetchCall) => Response | Promise<Response>,
  contributingPolicy: (call: FetchCall) => Response | Promise<Response> = () => jsonResponse({}, { status: 404 }),
) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const call: FetchCall = { url, headers: headerRecord(init) };
    calls.push(call);
    if (url === AI_USAGE_URL) return aiUsagePolicy(call);
    if (url === CONTRIBUTING_URL) return contributingPolicy(call);
    if (url.includes("/repos/acme/widgets/issues?")) return jsonResponse([issue(1)]);
    return jsonResponse({}, { status: 404 });
  });
  return calls;
}

async function discover(policyVerdictCache: unknown) {
  return fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
    apiBaseUrl: API,
    // biome-ignore lint/suspicious/noExplicitAny: the injected fake satisfies the structural PolicyVerdictCache surface.
    policyVerdictCache: policyVerdictCache as any,
  });
}

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opportunity fan-out policy-verdict cache (#4843)", () => {
  it("resolves and caches a fresh verdict on a cold cache", async () => {
    const cache = fakeVerdictCache();
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toMatchObject({ repoFullName: REPO, decisiveDoc: "AI-USAGE.md", etag: '"v1"' });
  });

  it("reuses a cached verdict outright when the decisive doc's ETag is unchanged", async () => {
    const cache = fakeVerdictCache();
    // Deliberately WRONG (blocking) verdict planted under a matching decisiveDoc + ETag: if the fresh "allowed"
    // fixture were re-resolved, the issue would survive. Its absence proves the cached verdict won, not a fresh one.
    cache.store.set(REPO, {
      decisiveDoc: "AI-USAGE.md",
      etag: '"v1"',
      verdict: { allowed: false, matchedPhrase: "fake-cached-ban", source: "AI-USAGE.md" },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues).toEqual([]);
    // A cache hit never re-writes: the entry set up above is untouched.
    expect(cache.puts).toEqual([]);
  });

  it("recomputes when the decisive doc's ETag has changed", async () => {
    const cache = fakeVerdictCache();
    cache.store.set(REPO, {
      decisiveDoc: "AI-USAGE.md",
      etag: '"v-old"',
      verdict: { allowed: false, matchedPhrase: "fake-cached-ban", source: "AI-USAGE.md" },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v-new"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toMatchObject({ decisiveDoc: "AI-USAGE.md", etag: '"v-new"' });
  });

  it("recomputes when the cached entry's decisive doc differs, even with a matching ETag", async () => {
    const cache = fakeVerdictCache();
    // Simulates a repo that previously had no AI-USAGE.md (CONTRIBUTING.md was decisive) and now does; the
    // decisiveDoc mismatch alone must force a recompute even though this ETag string happens to collide.
    cache.store.set(REPO, {
      decisiveDoc: "CONTRIBUTING.md",
      etag: '"v1"',
      verdict: { allowed: false, matchedPhrase: "fake-cached-ban", source: "CONTRIBUTING.md" },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toMatchObject({ decisiveDoc: "AI-USAGE.md", etag: '"v1"' });
  });

  it("caches and reuses a verdict decided by CONTRIBUTING.md when AI-USAGE.md is absent", async () => {
    const cache = fakeVerdictCache();
    const calls = stubFetch(
      () => jsonResponse({}, { status: 404 }),
      () => contentResponse(ALLOWED_AI_USAGE, '"c1"'),
    );

    const first = await discover(cache);
    expect(first.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toHaveLength(1);
    expect(cache.puts[0]).toMatchObject({ decisiveDoc: "CONTRIBUTING.md", etag: '"c1"' });
    const contributingCallCount = calls.filter((call) => call.url === CONTRIBUTING_URL).length;

    // Second run: same ETag on CONTRIBUTING.md -> the cached verdict is reused (no second write).
    cache.puts.length = 0;
    const second = await discover(cache);
    expect(second.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toEqual([]);
    expect(calls.filter((call) => call.url === CONTRIBUTING_URL).length).toBeGreaterThan(contributingCallCount);
  });

  it("treats a cache read failure as a miss and still resolves + writes fresh", async () => {
    const cache = fakeVerdictCache({
      getImpl: () => {
        throw new Error("corrupt cache");
      },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toHaveLength(1);
  });

  it("never fails discovery when the cache write throws", async () => {
    const cache = fakeVerdictCache({
      putImpl: () => {
        throw new Error("disk full");
      },
    });
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await discover(cache);

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(result.warnings).toEqual([]);
  });

  it("does not cache when no doc carries an ETag (both docs absent)", async () => {
    const cache = fakeVerdictCache();
    stubFetch(
      () => jsonResponse({}, { status: 404 }),
      () => jsonResponse({}, { status: 404 }),
    );

    const result = await discover(cache);

    // Neither doc exists: resolveAiPolicyVerdict({aiUsage: null, contributing: null}) silently allows.
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(cache.puts).toEqual([]);
  });

  it("resolves normally when no cache is supplied (feature is inert without one)", async () => {
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
  });

  it("persists across two runs with the real on-disk store, reusing the verdict on an unchanged ETag", async () => {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-policy-verdict-cache-fanout-"));
    roots.push(root);
    const dbPath = join(root, "policy-verdict-cache.sqlite3");
    const store = initPolicyVerdictCacheStore(dbPath);
    stores.push(store);

    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));
    const first = await discover(store);
    expect(first.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(store.get(REPO)).toMatchObject({ decisiveDoc: "AI-USAGE.md", etag: '"v1"' });

    vi.unstubAllGlobals();
    stubFetch(() => contentResponse(ALLOWED_AI_USAGE, '"v1"'));
    const second = await discover(store);
    expect(second.issues.map((entry) => entry.issueNumber)).toEqual([1]);

    // The verdict really landed on disk: a freshly reopened handle still has it.
    const reopened = initPolicyVerdictCacheStore(dbPath);
    stores.push(reopened);
    expect(reopened.get(REPO)).toMatchObject({ decisiveDoc: "AI-USAGE.md", etag: '"v1"' });
  });
});
