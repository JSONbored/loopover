import { describe, expect, it, vi } from "vitest";
import { pollCheckRuns } from "../../packages/gittensory-miner/lib/ci-poller.js";

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

// Three transient-failure modes the existing miner-ci-poller.test.ts (#2323) does not exercise (#4281). Because
// pollCheckRuns' attempt loop (ci-poller.js:200-225) wraps NO try/catch around fetchHeadSha/fetchCheckRuns, a single
// thrown error on attempt 1 aborts the whole poll immediately — it does not consume a backoff attempt and retry.
// These pin that current behavior (no silent retry, no swallow, no hang) rather than changing it; if the poll should
// instead retry on a 429, that is a separate feat/fix, deliberately not done here under a test-prefixed change.
describe("miner CI poller transient-failure modes (#4281)", () => {
  it.each([403, 429])(
    "propagates a %d response as github_<status> and does NOT retry through the remaining attempts",
    async (status) => {
      const sleepFn = vi.fn(async () => {});
      const fetchFn = vi.fn(async () => jsonResponse({ message: "API rate limit exceeded" }, { status }));

      await expect(
        pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, githubToken: "t", fetchFn, sleepFn, maxAttempts: 5 }),
      ).rejects.toMatchObject({ code: `github_${status}` });

      // The error surfaces on attempt 1's first request (the PR head-SHA fetch) and aborts the poll: no backoff
      // sleep is consumed and none of the remaining four attempts run.
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(sleepFn).not.toHaveBeenCalled();
    },
  );

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
