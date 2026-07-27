import { describe, expect, it, vi } from "vitest";
import { pollCheckRuns } from "../../packages/loopover-miner/lib/ci-poller";

const API = "https://api.github.com";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, init);
}
function prResponse(sha = "abc123") {
  return jsonResponse({ head: { sha } });
}
function checkRun(name: string, status: string, conclusion: string | null = null) {
  return {
    name,
    status,
    conclusion,
    details_url: `https://github.test/checks/${name}`,
    started_at: "2026-07-01T00:00:00Z",
    completed_at: status === "completed" ? "2026-07-01T00:01:00Z" : null,
  };
}

// Transient-failure modes the happy-path miner-ci-poller.test.ts (#2323) does not exercise (#4281). pollCheckRuns'
// attempt loop wraps NO try/catch around fetchHeadSha/fetchCheckRuns, so a THROWN error on attempt 1 aborts the
// whole poll immediately. #6761 refined the RESPONSE side: fetchWithRetry now rides out a transient RATE-LIMIT
// response (429, or a secondary-rate-limit 403 with a Retry-After / x-ratelimit-remaining: 0 header) within its
// bounded budget, but a PLAIN permission 403 (no rate-limit signal) is still not retried, and a thrown network
// error still propagates unretried. These pin those distinctions.
describe("miner CI poller transient-failure modes (#4281, #6761)", () => {
  it("propagates a plain permission 403 (no rate-limit headers) as github_403 without retrying", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => jsonResponse({ message: "Resource not accessible by integration" }, { status: 403 }));

    await expect(
      pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
    ).rejects.toMatchObject({ code: "github_403" });

    // Not a rate limit → not retried: the error surfaces on the very first (PR head-SHA) request and aborts the poll.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries a persistent 429 within fetchWithRetry's bounded budget, then surfaces github_429 (#6761)", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => jsonResponse({ message: "API rate limit exceeded" }, { status: 429 }));

    await expect(
      pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
    ).rejects.toMatchObject({ code: "github_429" });

    // The head-SHA fetch's fetchWithRetry now exhausts its default 3 attempts (2 backoff sleeps) on the persistent
    // 429 before the still-429 surfaces — a single transient spike would instead have been ridden out to success.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("propagates a fetchFn promise rejection (network timeout) during the PR head-SHA fetch", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => {
      throw new Error("network timeout");
    });

    await expect(
      pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
    ).rejects.toThrow("network timeout");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("propagates a fetchFn promise rejection during the check-runs fetch (after the PR fetch succeeds)", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) return prResponse("head-sha");
      throw new Error("network timeout");
    });

    await expect(
      pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
    ).rejects.toThrow("network timeout");
    // PR head-SHA fetch (resolves) + the throwing check-runs fetch = 2 calls, then abort.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("aborts deterministically when page 1 of check-runs succeeds but page 2 fails mid-pagination", async () => {
    const sleepFn = vi.fn(async () => {});
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/42")) return prResponse("head-sha");
      if (url.endsWith("page=1")) {
        // A non-empty page 1 carrying a rel="next" Link header forces continuation to page 2.
        return jsonResponse(
          { total_count: 2, check_runs: [checkRun("validate", "in_progress")] },
          {
            headers: {
              link: `<${API}/repos/acme/widgets/commits/head-sha/check-runs?per_page=100&page=2>; rel="next"`,
            },
          },
        );
      }
      // Page 2 fails outright — fetchCheckRuns has no per-page retry, so this propagates out of the whole poll.
      throw new Error("network timeout");
    });

    await expect(
      pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
    ).rejects.toThrow("network timeout");
    // PR head-SHA fetch + page 1 (resolves) + page 2 (throws) = 3 calls.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
