import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubClient } from "../../../packages/discovery-index/src/github-client";
import { counterValue, resetMetrics } from "../../../packages/discovery-index/src/metrics";

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function makeFetchStub(responses: Response[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} });
    const response = queue.shift();
    if (!response) throw new Error("makeFetchStub: no more responses queued");
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("discovery-index GitHubClient (#7164)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the real global fetch when no fetchImpl is injected", async () => {
    const globalFetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const client = new GitHubClient({ token: "tok", sleepFn: vi.fn() });
    await client.fetchRepoIssues("owner/repo");
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  describe("fetchRepoIssues", () => {
    it("fetches a single page and sends bearer auth when a token is configured", async () => {
      const { fetchImpl, calls } = makeFetchStub([
        new Response(JSON.stringify([{ number: 1, title: "A" }, { number: 2, title: "B", pull_request: {} }]), { status: 200 }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toHaveLength(2);
      expect(warnings).toEqual([]);
      expect(calls[0]!.url).toContain("/repos/owner/repo/issues");
      expect(calls[0]!.url).toContain("state=open&per_page=100");
      expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    });

    it("omits the authorization header when no token is configured", async () => {
      const { fetchImpl, calls } = makeFetchStub([new Response("[]", { status: 200 })]);
      const client = new GitHubClient({ token: "  ", fetchImpl, sleepFn: vi.fn() });
      await client.fetchRepoIssues("owner/repo");
      expect(calls[0]!.headers.authorization).toBeUndefined();
    });

    it("follows Link-header pagination up to maxPages", async () => {
      const withNext = (numbers: number[], nextPage: number | null) =>
        new Response(
          JSON.stringify(numbers.map((n) => ({ number: n, title: `Issue ${n}` }))),
          {
            status: 200,
            headers: nextPage
              ? { link: `<https://api.github.com/repos/owner/repo/issues?state=open&per_page=100&page=${nextPage}>; rel="next"` }
              : {},
          },
        );
      const { fetchImpl, calls } = makeFetchStub([withNext([1], 2), withNext([2], 3), withNext([3], 4)]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxPages: 2 });
      const { issues } = await client.fetchRepoIssues("owner/repo");
      expect(issues.map((i) => i.number)).toEqual([1, 2]);
      expect(calls).toHaveLength(2);
    });

    it("ignores a Link header pointing off-origin or off-path", async () => {
      const response = new Response(JSON.stringify([{ number: 1, title: "A" }]), {
        status: 200,
        headers: { link: '<https://evil.example.com/steal>; rel="next"' },
      });
      const { fetchImpl, calls } = makeFetchStub([response]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toHaveLength(1);
      expect(calls).toHaveLength(1);
    });

    it("ignores an unparseable Link header URL", async () => {
      const response = new Response(JSON.stringify([{ number: 1, title: "A" }]), {
        status: 200,
        headers: { link: '<http://[invalid>; rel="next"' },
      });
      const { fetchImpl, calls } = makeFetchStub([response]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      await client.fetchRepoIssues("owner/repo");
      expect(calls).toHaveLength(1);
    });

    it("warns and stops on a non-ok, non-retryable response", async () => {
      const { fetchImpl } = makeFetchStub([new Response("nope", { status: 404 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toEqual([]);
      expect(warnings[0]).toMatch(/404/);
    });

    it("warns on a non-array issues payload", async () => {
      const { fetchImpl } = makeFetchStub([new Response(JSON.stringify({ not: "array" }), { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toEqual([]);
      expect(warnings[0]).toMatch(/non-array/);
    });

    it("retries a transient 5xx and succeeds, sleeping between attempts", async () => {
      const { fetchImpl, calls } = makeFetchStub([
        new Response("err", { status: 500 }),
        new Response(JSON.stringify([{ number: 1, title: "A" }]), { status: 200 }),
      ]);
      const sleepFn = vi.fn(async () => undefined);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn, maxAttempts: 3 });
      const { issues, warnings } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toHaveLength(1);
      expect(warnings).toEqual([]);
      expect(sleepFn).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
    });

    it("gives up after maxAttempts and reports the lingering error status", async () => {
      const { fetchImpl } = makeFetchStub([new Response("err", { status: 500 }), new Response("err", { status: 500 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 2 });
      const { issues, warnings } = await client.fetchRepoIssues("owner/repo");
      expect(issues).toEqual([]);
      expect(warnings[0]).toMatch(/500/);
    });

    it("falls back to exponential backoff (no Retry-After header at all)", async () => {
      const { fetchImpl } = makeFetchStub([new Response("err", { status: 500 }), new Response("[]", { status: 200 })]);
      const sleepFn = vi.fn(async () => undefined);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn, maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(sleepFn).toHaveBeenCalledWith(500);
    });

    it("falls back to exponential backoff for a present but non-numeric Retry-After value", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("err", { status: 500, headers: { "retry-after": "not-a-number" } }),
        new Response("[]", { status: 200 }),
      ]);
      const sleepFn = vi.fn(async () => undefined);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn, maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(sleepFn).toHaveBeenCalledWith(500);
    });

    it("uses the real default sleep implementation when no sleepFn is injected", async () => {
      vi.useFakeTimers();
      try {
        const { fetchImpl, calls } = makeFetchStub([new Response("err", { status: 500 }), new Response("[]", { status: 200 })]);
        const client = new GitHubClient({ token: "tok", fetchImpl, maxAttempts: 2 });
        const resultPromise = client.fetchRepoIssues("owner/repo");
        await vi.advanceTimersByTimeAsync(500);
        await resultPromise;
        expect(calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("honors a Retry-After header when it exceeds the exponential backoff", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("rl", { status: 429, headers: { "retry-after": "1" } }),
        new Response("[]", { status: 200 }),
      ]);
      const sleepFn = vi.fn(async () => undefined);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn, maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(sleepFn).toHaveBeenCalledWith(1000);
    });

    it("falls back to exponential backoff when Retry-After is smaller than it", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("rl", { status: 429, headers: { "retry-after": "0" } }),
        new Response("[]", { status: 200 }),
      ]);
      const sleepFn = vi.fn(async () => undefined);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn, maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(sleepFn).toHaveBeenCalledWith(500);
    });

    it("retries a secondary-rate-limit 403 signaled by a Retry-After header", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("sec", { status: 403, headers: { "retry-after": "1" } }),
        new Response("[]", { status: 200 }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 2 });
      const { warnings } = await client.fetchRepoIssues("owner/repo");
      expect(warnings).toEqual([]);
    });

    it("retries a secondary-rate-limit 403 signaled by x-ratelimit-remaining: 0", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("sec", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
        new Response("[]", { status: 200 }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 2 });
      const { warnings } = await client.fetchRepoIssues("owner/repo");
      expect(warnings).toEqual([]);
    });

    it("does not retry a plain permission-denied 403 (no rate-limit signal)", async () => {
      const { fetchImpl, calls } = makeFetchStub([new Response("forbidden", { status: 403 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 3 });
      const { warnings } = await client.fetchRepoIssues("owner/repo");
      expect(calls).toHaveLength(1);
      expect(warnings[0]).toMatch(/403/);
    });

    it("does not retry a 403 with a present but non-zero x-ratelimit-remaining", async () => {
      const { fetchImpl, calls } = makeFetchStub([new Response("forbidden", { status: 403, headers: { "x-ratelimit-remaining": "50" } })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(calls).toHaveLength(1);
    });

    it("applies a per-attempt request timeout signal when configured", async () => {
      const { fetchImpl, calls } = makeFetchStub([new Response("[]", { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), requestTimeoutMs: 5000 });
      await client.fetchRepoIssues("owner/repo");
      expect(calls).toHaveLength(1);
    });

    it("tracks the minimum observed remaining and maximum observed reset, ignoring calls with no headers", async () => {
      const now = Math.floor(Date.now() / 1000);
      const { fetchImpl } = makeFetchStub([
        new Response("[]", { status: 200, headers: { "x-ratelimit-remaining": "50", "x-ratelimit-reset": String(now + 100) } }),
        new Response("[]", { status: 200, headers: { "x-ratelimit-remaining": "80", "x-ratelimit-reset": String(now + 10) } }),
        new Response("[]", { status: 200, headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(now + 200) } }),
        new Response("[]", { status: 200 }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      expect(client.lastRateLimit).toEqual({ remaining: null, resetAt: null });
      await client.fetchRepoIssues("a/b");
      expect(client.lastRateLimit.remaining).toBe(50);
      const resetAfterFirst = client.lastRateLimit.resetAt;
      await client.fetchRepoIssues("a/b");
      expect(client.lastRateLimit.remaining).toBe(50); // min(50, 80) stays 50
      expect(client.lastRateLimit.resetAt).toBe(resetAfterFirst); // now+10 doesn't beat now+100
      await client.fetchRepoIssues("a/b");
      expect(client.lastRateLimit.remaining).toBe(10); // min(50, 10) -> 10
      expect(client.lastRateLimit.resetAt).not.toBe(resetAfterFirst); // now+200 beats now+100
      await client.fetchRepoIssues("a/b"); // no rate-limit headers at all -> no change
      expect(client.lastRateLimit.remaining).toBe(10);
    });

    it("ignores a present but non-numeric or non-positive rate-limit header value", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("[]", { status: 200, headers: { "x-ratelimit-remaining": "not-a-number", "x-ratelimit-reset": "0" } }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      await client.fetchRepoIssues("a/b");
      expect(client.lastRateLimit).toEqual({ remaining: null, resetAt: null });
    });
  });

  describe("searchIssues", () => {
    it("returns immediately for a blank query without calling fetch", async () => {
      const { fetchImpl, calls } = makeFetchStub([]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.searchIssues("   ");
      expect(issues).toEqual([]);
      expect(warnings).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    it("searches issues and follows pagination", async () => {
      const { fetchImpl, calls } = makeFetchStub([new Response(JSON.stringify({ items: [{ number: 1, title: "A" }] }), { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues } = await client.searchIssues("is:open bug");
      expect(issues).toHaveLength(1);
      expect(calls[0]!.url).toContain("/search/issues?q=");
    });

    it("warns on a non-ok search response", async () => {
      const { fetchImpl } = makeFetchStub([new Response("err", { status: 422 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.searchIssues("bug");
      expect(issues).toEqual([]);
      expect(warnings[0]).toMatch(/422/);
    });

    it("warns on a search payload missing an items array", async () => {
      const { fetchImpl } = makeFetchStub([new Response(JSON.stringify({ nope: true }), { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { issues, warnings } = await client.searchIssues("bug");
      expect(issues).toEqual([]);
      expect(warnings[0]).toMatch(/non-array/);
    });
  });

  describe("fetchRepoFile", () => {
    it("fetches and base64-decodes a repo file's content", async () => {
      const encoded = Buffer.from("hello world", "utf8").toString("base64");
      const { fetchImpl } = makeFetchStub([new Response(JSON.stringify({ content: encoded, encoding: "base64" }), { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      const { content } = await client.fetchRepoFile("owner/repo", "AI-USAGE.md");
      expect(content).toBe("hello world");
    });

    it("returns null content on a 404", async () => {
      const { fetchImpl } = makeFetchStub([new Response("nf", { status: 404 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      expect((await client.fetchRepoFile("o/r", "X.md")).content).toBeNull();
    });

    it("returns null content on a non-ok response other than 404", async () => {
      const { fetchImpl } = makeFetchStub([new Response("err", { status: 500 }), new Response("err", { status: 500 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 2 });
      expect((await client.fetchRepoFile("o/r", "X.md")).content).toBeNull();
    });

    it("returns null content when the payload is missing content or the wrong encoding", async () => {
      const { fetchImpl: missingContent } = makeFetchStub([new Response(JSON.stringify({ encoding: "base64" }), { status: 200 })]);
      const client1 = new GitHubClient({ token: "tok", fetchImpl: missingContent, sleepFn: vi.fn() });
      expect((await client1.fetchRepoFile("o/r", "X.md")).content).toBeNull();

      const { fetchImpl: wrongEncoding } = makeFetchStub([new Response(JSON.stringify({ content: "aGk=", encoding: "none" }), { status: 200 })]);
      const client2 = new GitHubClient({ token: "tok", fetchImpl: wrongEncoding, sleepFn: vi.fn() });
      expect((await client2.fetchRepoFile("o/r", "X.md")).content).toBeNull();

      const { fetchImpl: notObject } = makeFetchStub([new Response("null", { status: 200 })]);
      const client3 = new GitHubClient({ token: "tok", fetchImpl: notObject, sleepFn: vi.fn() });
      expect((await client3.fetchRepoFile("o/r", "X.md")).content).toBeNull();
    });
  });

  describe("discovery_index_github_requests_total metric", () => {
    const ok = () => counterValue("discovery_index_github_requests_total", { outcome: "ok" });
    const retried = () => counterValue("discovery_index_github_requests_total", { outcome: "retried" });
    const failed = () => counterValue("discovery_index_github_requests_total", { outcome: "failed" });

    it("emits exactly one ok for a single successful request", async () => {
      const { fetchImpl } = makeFetchStub([new Response("[]", { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn() });
      await client.fetchRepoIssues("owner/repo");
      expect(ok()).toBe(1);
      expect(retried()).toBe(0);
      expect(failed()).toBe(0);
    });

    it("emits one retried then one ok for a request that 5xx-es once then succeeds", async () => {
      const { fetchImpl } = makeFetchStub([new Response("err", { status: 500 }), new Response("[]", { status: 200 })]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(retried()).toBe(1);
      expect(ok()).toBe(1);
      expect(failed()).toBe(0);
    });

    it("emits one retried per extra attempt then one failed when maxAttempts is exhausted", async () => {
      const { fetchImpl } = makeFetchStub([
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
        new Response("err", { status: 500 }),
      ]);
      const client = new GitHubClient({ token: "tok", fetchImpl, sleepFn: vi.fn(), maxAttempts: 3 });
      await client.fetchRepoIssues("owner/repo");
      expect(retried()).toBe(2); // two retries before the third (final) attempt
      expect(failed()).toBe(1);
      expect(ok()).toBe(0);
    });
  });
});
