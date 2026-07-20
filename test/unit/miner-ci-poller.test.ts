import { describe, expect, it, vi } from "vitest";
import { pollCheckRuns } from "../../packages/loopover-miner/lib/ci-poller.js";

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

function checksResponse(checks: unknown[], init: ResponseInit & { totalCount?: number } = {}) {
  const { totalCount, ...responseInit } = init;
  return jsonResponse({ total_count: totalCount ?? checks.length, check_runs: checks }, responseInit);
}

describe("miner CI check-run poller (#2323)", () => {
  it("fetches PR head SHA and check runs with read-only authenticated GET requests", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/42")) return prResponse("head-sha");
      if (url.endsWith("/repos/acme/widgets/commits/head-sha/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await pollCheckRuns("acme/widgets", 42, {
      apiBaseUrl: API,
      githubToken: "github-token",
      fetchFn,
    });

    expect(result).toEqual({
      conclusion: "success",
      headSha: "head-sha",
      attempts: 1,
      checks: [
        {
          name: "validate",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://github.test/checks/validate",
          startedAt: "2026-07-01T00:00:00Z",
          completedAt: "2026-07-01T00:01:00Z",
        },
      ],
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(fetchFn.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(
      fetchFn.mock.calls.every(
        ([, init]) => (init?.headers as Record<string, string>).authorization === "Bearer github-token",
      ),
    ).toBe(true);
  });

  it("retries a transient 5xx from GitHub during the poll and completes (#4829)", async () => {
    let checkRunsAttempts = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/42")) return prResponse("head-sha");
      if (url.includes("/check-runs")) {
        checkRunsAttempts += 1;
        if (checkRunsAttempts === 1) return jsonResponse({}, { status: 503 }); // a brief transient server error
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      return jsonResponse({}, { status: 404 });
    });
    const result = await pollCheckRuns("acme/widgets", 42, {
      apiBaseUrl: API,
      githubToken: "github-token",
      fetchFn,
      sleepFn: () => Promise.resolve(), // no real backoff delay in the test
    });
    expect(checkRunsAttempts).toBe(2); // the 503 was retried, then succeeded
    expect(result.conclusion).toBe("success"); // the poll completed despite the transient 5xx
  });

  it("retries a transient 429 rate-limit from GitHub during the poll and completes (#6761)", async () => {
    let checkRunsAttempts = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/42")) return prResponse("head-sha");
      if (url.includes("/check-runs")) {
        checkRunsAttempts += 1;
        if (checkRunsAttempts === 1) return jsonResponse({ message: "API rate limit exceeded" }, { status: 429 }); // a transient rate limit
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      return jsonResponse({}, { status: 404 });
    });
    const result = await pollCheckRuns("acme/widgets", 42, {
      apiBaseUrl: API,
      githubToken: "github-token",
      fetchFn,
      sleepFn: () => Promise.resolve(), // no real backoff delay in the test
    });
    expect(checkRunsAttempts).toBe(2); // the 429 was retried within the bounded budget, then succeeded
    expect(result.conclusion).toBe("success"); // the poll completed instead of aborting on the rate limit
  });

  it("rejects untrusted apiBaseUrl values before any token-bearing request", async () => {
    const fetchFn = vi.fn();
    for (const apiBaseUrl of [
      "http://api.github.com",
      "https://evil.example",
      "https://api.github.com.evil.example",
      "not a url",
    ]) {
      await expect(
        pollCheckRuns("acme/widgets", 42, {
          apiBaseUrl,
          githubToken: "github-token",
          fetchFn,
        }),
      ).rejects.toThrow("invalid_api_base_url");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses the default GitHub API base URL when apiBaseUrl is omitted", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.github.com/repos/acme/widgets/pulls/42") return prResponse("head-sha");
      if (url === "https://api.github.com/repos/acme/widgets/commits/head-sha/check-runs?per_page=100&page=1") {
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      return jsonResponse({}, { status: 404 });
    });

    await expect(pollCheckRuns("acme/widgets", 42, { fetchFn })).resolves.toMatchObject({
      conclusion: "success",
    });
  });

  it("follows paginated check-run responses before aggregating failures (regression for #2621)", async () => {
    const pageOneChecks = Array.from({ length: 100 }, (_, index) =>
      checkRun(`success-${index}`, "completed", "success"),
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/43")) return prResponse("many-checks-sha");
      if (url.endsWith("/repos/acme/widgets/commits/many-checks-sha/check-runs?per_page=100&page=1")) {
        return checksResponse(pageOneChecks, {
          totalCount: 101,
          headers: {
            link: `<${API}/repos/acme/widgets/commits/many-checks-sha/check-runs?per_page=100&page=2>; rel="next"`,
          },
        });
      }
      if (url.endsWith("/repos/acme/widgets/commits/many-checks-sha/check-runs?per_page=100&page=2")) {
        return checksResponse([checkRun("late-failure", "completed", "failure")], { totalCount: 101 });
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await pollCheckRuns("acme/widgets", 43, { apiBaseUrl: API, fetchFn });

    expect(result.conclusion).toBe("failure");
    expect(result.checks).toHaveLength(101);
    expect(result.checks.at(-1)).toMatchObject({ name: "late-failure", conclusion: "failure" });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it("normalizes failed terminal conclusions, including stale, to failure", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(
        checksResponse([
          checkRun("validate", "completed", "success"),
          checkRun("workers", "completed", "timed_out"),
          checkRun("expired", "completed", "stale"),
        ]),
      )
      .mockResolvedValueOnce(prResponse());

    await expect(
      pollCheckRuns("acme/widgets", 7, { apiBaseUrl: API, fetchFn }),
    ).resolves.toMatchObject({
      conclusion: "failure",
      checks: [
        { name: "validate", conclusion: "success" },
        { name: "workers", conclusion: "failure" },
        { name: "expired", conclusion: "failure" },
      ],
    });
  });

  it("treats a completed stale check run as terminal failure (regression for #2621)", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(checksResponse([checkRun("github-timeout", "completed", "stale")]))
      .mockResolvedValueOnce(prResponse());

    await expect(
      pollCheckRuns("acme/widgets", 7, {
        apiBaseUrl: API,
        fetchFn,
        maxAttempts: 3,
        sleepFn: vi.fn(),
      }),
    ).resolves.toMatchObject({
      conclusion: "failure",
      attempts: 1,
      checks: [{ name: "github-timeout", conclusion: "failure" }],
    });
  });

  it("keeps pending when checks are queued or absent", async () => {
    const queuedFetch = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(checksResponse([checkRun("validate", "queued")]));
    await expect(
      pollCheckRuns("acme/widgets", 8, { apiBaseUrl: API, fetchFn: queuedFetch }),
    ).resolves.toMatchObject({ conclusion: "pending" });

    const emptyFetch = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(checksResponse([]));
    await expect(
      pollCheckRuns("acme/widgets", 8, { apiBaseUrl: API, fetchFn: emptyFetch }),
    ).resolves.toMatchObject({ conclusion: "pending", checks: [] });
  });

  it("returns neutral when terminal checks are neither failing nor all-success", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(
        checksResponse([
          checkRun("validate", "completed", "success"),
          checkRun("docs", "completed", "neutral"),
        ]),
      )
      .mockResolvedValueOnce(prResponse());

    await expect(
      pollCheckRuns("acme/widgets", 9, { apiBaseUrl: API, fetchFn }),
    ).resolves.toMatchObject({ conclusion: "neutral" });
  });

  it("backs off between pending polls until a terminal conclusion is observed", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse("head-sha"))
      .mockResolvedValueOnce(checksResponse([checkRun("validate", "in_progress")]))
      .mockResolvedValueOnce(prResponse("head-sha"))
      .mockResolvedValueOnce(checksResponse([checkRun("validate", "queued")]))
      .mockResolvedValueOnce(prResponse("head-sha"))
      .mockResolvedValueOnce(checksResponse([checkRun("validate", "completed", "success")]))
      .mockResolvedValueOnce(prResponse("head-sha"));

    const result = await pollCheckRuns("acme/widgets", 10, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 3,
      minIntervalMs: 100,
      maxIntervalMs: 150,
      sleepFn: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(result).toMatchObject({ conclusion: "success", attempts: 3 });
    expect(sleeps).toEqual([100, 150]);
    expect(fetchFn).toHaveBeenCalledTimes(7);
  });

  it("re-resolves the PR head on every retry so a force-push during backoff polls the new commit", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/12")) {
        const pollCount = fetchFn.mock.calls.filter(([request]) => String(request).endsWith("/repos/acme/widgets/pulls/12"))
          .length;
        return prResponse(pollCount === 1 ? "old-head" : "new-head");
      }
      if (url.endsWith("/repos/acme/widgets/commits/old-head/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "queued")]);
      }
      if (url.endsWith("/repos/acme/widgets/commits/new-head/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await pollCheckRuns("acme/widgets", 12, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 2,
      minIntervalMs: 100,
      maxIntervalMs: 100,
      sleepFn: async (delayMs) => {
        sleeps.push(delayMs);
      },
    });

    expect(result).toMatchObject({
      conclusion: "success",
      headSha: "new-head",
      attempts: 2,
      checks: [{ name: "validate", conclusion: "success" }],
    });
    expect(sleeps).toEqual([100]);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it("re-checks the PR head before returning a terminal result and retries when it drifted", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/13")) {
        const pollCount = fetchFn.mock.calls.filter(([request]) => String(request).endsWith("/repos/acme/widgets/pulls/13"))
          .length;
        if (pollCount <= 2) return prResponse(pollCount === 1 ? "old-head" : "new-head");
        return prResponse("new-head");
      }
      if (url.endsWith("/repos/acme/widgets/commits/old-head/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "completed", "success")]);
      }
      if (url.endsWith("/repos/acme/widgets/commits/new-head/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "completed", "failure")]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await pollCheckRuns("acme/widgets", 13, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 2,
      minIntervalMs: 100,
      maxIntervalMs: 100,
      sleepFn: vi.fn(),
    });

    expect(result).toMatchObject({
      conclusion: "failure",
      headSha: "new-head",
      attempts: 2,
      checks: [{ name: "validate", conclusion: "failure" }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("validates repo and PR input before fetching", async () => {
    const fetchFn = vi.fn();

    await expect(
      pollCheckRuns("missing-slash", 1, { apiBaseUrl: API, fetchFn }),
    ).rejects.toThrow("invalid_repo_full_name");
    await expect(
      pollCheckRuns("acme/widgets", 0, { apiBaseUrl: API, fetchFn }),
    ).rejects.toThrow("invalid_pr_number");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces GitHub and malformed PR responses as deterministic errors", async () => {
    const missingPr = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "not found" }, { status: 404 }));
    await expect(
      pollCheckRuns("acme/widgets", 11, { apiBaseUrl: API, fetchFn: missingPr }),
    ).rejects.toThrow("github_404: not found");

    const missingSha = vi.fn().mockResolvedValueOnce(jsonResponse({ head: {} }));
    await expect(
      pollCheckRuns("acme/widgets", 11, { apiBaseUrl: API, fetchFn: missingSha }),
    ).rejects.toThrow("github_pr_head_sha_missing");
  });

  it("surfaces malformed check-run responses as deterministic errors", async () => {
    const malformedChecks = vi
      .fn()
      .mockResolvedValueOnce(prResponse())
      .mockResolvedValueOnce(jsonResponse({ total_count: 1, check_runs: null }));

    await expect(
      pollCheckRuns("acme/widgets", 12, { apiBaseUrl: API, fetchFn: malformedChecks }),
    ).rejects.toThrow("github_check_runs_malformed");
  });

  it("bounds every GitHub request with a per-attempt AbortSignal timeout, defaulting to 10s (#miner-github-read-timeouts)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/42")) return prResponse("head-sha");
      if (url.endsWith("/repos/acme/widgets/commits/head-sha/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "queued")]); // pending: no re-check-head-sha call
      }
      return jsonResponse({}, { status: 404 });
    });

    await pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(2); // head-sha + check-runs
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    for (const [, init] of fetchFn.mock.calls) {
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
    timeoutSpy.mockRestore();
  });

  it("honors a custom requestTimeoutMs instead of the 10s default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repos/acme/widgets/pulls/42")) return prResponse("head-sha");
      if (url.endsWith("/repos/acme/widgets/commits/head-sha/check-runs?per_page=100&page=1")) {
        return checksResponse([checkRun("validate", "queued")]);
      }
      return jsonResponse({}, { status: 404 });
    });

    await pollCheckRuns("acme/widgets", 42, { apiBaseUrl: API, fetchFn, requestTimeoutMs: 2500 });

    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 2500)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("rejects a non-string repo full name", async () => {
    await expect(
      pollCheckRuns(null as unknown as string, 1, { apiBaseUrl: API, fetchFn: vi.fn() }),
    ).rejects.toThrow("invalid_repo_full_name");
  });

  it("falls back to the default API base for non-string and blank apiBaseUrl", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith("https://api.github.com/")).toBe(true);
      if (url.includes("/pulls/")) return prResponse("sha-default");
      if (url.includes("/check-runs")) {
        return checksResponse([
          null,
          { status: "completed", conclusion: "startup_failure" },
          { name: "mystery", status: "completed", conclusion: "mystery" },
          { name: "skipped", status: "completed", conclusion: "skipped" },
          { name: "neutral", status: "completed", conclusion: "neutral" },
          { name: "cancelled", status: "completed", conclusion: "cancelled" },
          { name: "action_required", status: "completed", conclusion: "action_required" },
          checkRun("ok", "completed", "success"),
        ]);
      }
      return jsonResponse({}, { status: 404 });
    });
    await expect(
      pollCheckRuns("acme/widgets", 9, {
        apiBaseUrl: 42 as unknown as string,
        githubToken: "  tok  ",
        fetchFn,
        maxAttempts: Number.NaN,
        minIntervalMs: Number.NaN,
        maxIntervalMs: Number.NaN,
        requestTimeoutMs: Number.NaN,
        sleepFn: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({ conclusion: "failure" });

    const blankBase = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/")) return prResponse("sha-blank");
      if (url.includes("/check-runs")) return checksResponse([checkRun("ok", "completed", "success")]);
      return jsonResponse({}, { status: 404 });
    });
    await expect(
      pollCheckRuns("acme/widgets", 10, { apiBaseUrl: "   ", fetchFn: blankBase, sleepFn: vi.fn(async () => {}) }),
    ).resolves.toMatchObject({ conclusion: "success" });
  });

  it("surfaces a GitHub error with a whitespace-only message as a bare status code", async () => {
    const bareError = vi.fn().mockResolvedValue(jsonResponse({ message: "   " }, { status: 404 }));
    await expect(
      pollCheckRuns("acme/widgets", 11, { apiBaseUrl: API, fetchFn: bareError, sleepFn: vi.fn(async () => {}) }),
    ).rejects.toThrow("github_404");
  });

  it("throws when pagination ends with an empty page before the reported total", async () => {
    const incompletePage = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/13")) return prResponse("page-sha");
      // Match `&page=N` (not `per_page=`) so page 2 is not mis-routed as page 1.
      if (url.includes("&page=1")) {
        return jsonResponse({ total_count: 2, check_runs: [checkRun("a", "completed", "success")] });
      }
      if (url.includes("&page=2")) {
        return jsonResponse({ total_count: 2, check_runs: [] });
      }
      return jsonResponse({}, { status: 404 });
    });
    await expect(
      pollCheckRuns("acme/widgets", 13, {
        apiBaseUrl: API,
        fetchFn: incompletePage,
        sleepFn: vi.fn(async () => {}),
      }),
    ).rejects.toThrow("github_check_runs_pagination_incomplete");
  });

  it("returns pending after exhausting maxAttempts", async () => {
    const pendingForever = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/")) return prResponse("pending-sha");
      if (url.includes("/check-runs")) return checksResponse([checkRun("validate", "queued")]);
      return jsonResponse({}, { status: 404 });
    });
    await expect(
      pollCheckRuns("acme/widgets", 14, {
        apiBaseUrl: API,
        fetchFn: pendingForever,
        sleepFn: vi.fn(async () => {}),
        maxAttempts: 2,
        minIntervalMs: 1,
        maxIntervalMs: 2,
      }),
    ).resolves.toMatchObject({ conclusion: "pending", attempts: 2 });
  });

  it("uses global fetch when fetchFn is omitted", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/15")) return prResponse("global-sha");
      if (url.includes("/check-runs")) return checksResponse([checkRun("validate", "queued")]);
      return jsonResponse({}, { status: 404 });
    }) as typeof fetch;
    try {
      await expect(
        pollCheckRuns("acme/widgets", 15, {
          apiBaseUrl: API,
          maxAttempts: 1,
          sleepFn: vi.fn(async () => {}),
        }),
      ).resolves.toMatchObject({ conclusion: "pending", attempts: 1 });
      expect(globalThis.fetch).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps a prior total_count when a later page omits a valid count, and rejects a negative total_count", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/17")) return prResponse("neg-sha");
      if (url.includes("&page=1")) {
        return jsonResponse(
          { total_count: 2, check_runs: [checkRun("a", "completed", "success")] },
          {
            headers: {
              link: `<${API}/repos/acme/widgets/commits/neg-sha/check-runs?per_page=100&page=2>; rel="next"`,
            },
          },
        );
      }
      if (url.includes("&page=2")) {
        // Invalid/negative total_count → payloadTotalCount null, so ?? keeps the prior expected total.
        return jsonResponse({ total_count: -1, check_runs: [checkRun("b", "completed", "success")] });
      }
      return jsonResponse({}, { status: 404 });
    });
    await expect(
      pollCheckRuns("acme/widgets", 17, {
        apiBaseUrl: API,
        fetchFn,
        sleepFn: vi.fn(async () => {}),
      }),
    ).resolves.toMatchObject({ conclusion: "success", checks: [{ name: "a" }, { name: "b" }] });
  });

  it("uses the default sleepFn (setTimeout) between pending polls when sleepFn is omitted", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pulls/")) return prResponse("sleep-sha");
      if (url.includes("/check-runs")) return checksResponse([checkRun("validate", "queued")]);
      return jsonResponse({}, { status: 404 });
    });
    try {
      const pending = pollCheckRuns("acme/widgets", 16, {
        apiBaseUrl: API,
        fetchFn,
        maxAttempts: 2,
        minIntervalMs: 10,
        maxIntervalMs: 10,
        requestTimeoutMs: 1000,
      });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toMatchObject({ conclusion: "pending", attempts: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});
