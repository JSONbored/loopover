import { describe, expect, it, vi } from "vitest";
import { classifyPrDisposition, pollPrDisposition } from "../../packages/loopover-miner/lib/pr-disposition-poller";

const API = "https://api.github.com";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, init);
}

function prResponse(overrides: Record<string, unknown> = {}) {
  return jsonResponse({ state: "open", merged: false, closed_at: null, ...overrides });
}

describe("PR disposition poller (#5135)", () => {
  it("fetches a real PR's disposition with a read-only authenticated GET request", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => prResponse({ state: "open" }));

    const result = await pollPrDisposition("acme/widgets", 42, {
      apiBaseUrl: API,
      githubToken: "github-token",
      fetchFn,
    });

    expect(result).toEqual({ state: "open", merged: false, closedAt: null, attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(`${API}/repos/acme/widgets/pulls/42`);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer github-token");
  });

  it("retries a transient 5xx from the GitHub API during a poll and completes (#4829)", async () => {
    let attempts = 0;
    const fetchFn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({}, { status: 503 }); // a brief transient server error
      return prResponse({ state: "closed", merged: true, closed_at: "2026-07-12T00:00:00Z" });
    });

    const result = await pollPrDisposition("acme/widgets", 42, {
      apiBaseUrl: API,
      fetchFn,
      sleepFn: async () => {}, // keep the per-call retry backoff instant
    });

    expect(attempts).toBe(2); // the 503 was retried, then succeeded — not surfaced as an immediate failure
    expect(result).toMatchObject({ state: "closed", merged: true });
  });

  it("retries a transient 429 rate-limit from the GitHub API during a poll and completes (#6761)", async () => {
    let attempts = 0;
    const fetchFn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ message: "API rate limit exceeded" }, { status: 429 }); // a transient rate limit
      return prResponse({ state: "closed", merged: true, closed_at: "2026-07-12T00:00:00Z" });
    });

    const result = await pollPrDisposition("acme/widgets", 42, {
      apiBaseUrl: API,
      fetchFn,
      sleepFn: async () => {}, // keep the per-call retry backoff instant
    });

    expect(attempts).toBe(2); // the 429 was retried, then succeeded — not surfaced as an immediate failure
    expect(result).toMatchObject({ state: "closed", merged: true });
  });

  it("returns terminal merged disposition immediately, without further polling", async () => {
    const fetchFn = vi.fn(async () =>
      prResponse({ state: "closed", merged: true, closed_at: "2026-07-12T00:00:00Z" }),
    );

    const result = await pollPrDisposition("acme/widgets", 7, { apiBaseUrl: API, fetchFn, maxAttempts: 5 });

    expect(result).toEqual({ state: "closed", merged: true, closedAt: "2026-07-12T00:00:00Z", attempts: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns terminal closed-unmerged (disengaged) disposition immediately", async () => {
    const fetchFn = vi.fn(async () =>
      prResponse({ state: "closed", merged: false, closed_at: "2026-07-12T00:00:00Z" }),
    );

    const result = await pollPrDisposition("acme/widgets", 8, { apiBaseUrl: API, fetchFn });

    expect(result).toEqual({ state: "closed", merged: false, closedAt: "2026-07-12T00:00:00Z", attempts: 1 });
  });

  it("uses the default GitHub API base URL when apiBaseUrl is omitted", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.github.com/repos/acme/widgets/pulls/9");
      return prResponse({ state: "closed", merged: true });
    });

    await expect(pollPrDisposition("acme/widgets", 9, { fetchFn })).resolves.toMatchObject({ merged: true });
  });

  it("rejects untrusted apiBaseUrl values before any token-bearing request", async () => {
    const fetchFn = vi.fn();
    for (const apiBaseUrl of [
      "http://api.github.com",
      "https://evil.example",
      "https://api.github.com.evil.example",
      "not a url",
    ]) {
      await expect(pollPrDisposition("acme/widgets", 42, { apiBaseUrl, fetchFn })).rejects.toThrow(
        "invalid_api_base_url",
      );
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("treats a blank apiBaseUrl as the default GitHub base, and rejects a non-string repoFullName", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL) =>
      prResponse({ state: "closed", merged: true, closed_at: "2026-07-12T00:00:00Z" }),
    );
    const result = await pollPrDisposition("acme/widgets", 5, { apiBaseUrl: "   ", fetchFn });
    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://api.github.com/repos/acme/widgets/pulls/5");
    expect(result.merged).toBe(true);
    await expect(pollPrDisposition(123 as never, 5, { fetchFn })).rejects.toThrow("invalid_repo_full_name");
  });

  it("falls back to the global fetch when fetchFn is omitted", async () => {
    const stub = vi.fn(async () => prResponse({ state: "closed", merged: false, closed_at: "2026-07-12T00:00:00Z" }));
    vi.stubGlobal("fetch", stub);
    try {
      const result = await pollPrDisposition("acme/widgets", 6, { apiBaseUrl: API });
      expect(result).toMatchObject({ state: "closed", merged: false, attempts: 1 });
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a GitHub error with its message, and one without a message, as deterministic errors", async () => {
    const withMessage = vi.fn(async () => jsonResponse({ message: "Not Found" }, { status: 404 }));
    await expect(
      pollPrDisposition("acme/widgets", 7, { apiBaseUrl: API, fetchFn: withMessage, sleepFn: async () => {} }),
    ).rejects.toThrow("github_404: Not Found");
    // A 5xx with no usable message body surfaces as the bare status code (after fetchWithRetry's own retries).
    const noMessage = vi.fn(async () => jsonResponse({}, { status: 500 }));
    await expect(
      pollPrDisposition("acme/widgets", 8, { apiBaseUrl: API, fetchFn: noMessage, sleepFn: async () => {} }),
    ).rejects.toThrow(/^github_500$/);
  });

  it("treats an unparseable PR response body as an empty (still-open) disposition", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    }));
    // response.json() rejects -> the `.catch(() => null)` yields a null payload -> normalized as still-open.
    const result = await pollPrDisposition("acme/widgets", 13, { apiBaseUrl: API, fetchFn: fetchFn as never });
    expect(result).toMatchObject({ state: "open", merged: false, attempts: 1 });
  });

  it("backs off between polls while the PR stays open, until it reaches a terminal disposition", async () => {
    const sleeps: number[] = [];
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse({ state: "open" }))
      .mockResolvedValueOnce(prResponse({ state: "open" }))
      .mockResolvedValueOnce(prResponse({ state: "closed", merged: true, closed_at: "2026-07-12T01:00:00Z" }));

    const result = await pollPrDisposition("acme/widgets", 10, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 3,
      minIntervalMs: 100,
      maxIntervalMs: 150,
      sleepFn: async (delayMs: number) => {
        sleeps.push(delayMs);
      },
    });

    expect(result).toEqual({ state: "closed", merged: true, closedAt: "2026-07-12T01:00:00Z", attempts: 3 });
    expect(sleeps).toEqual([100, 150]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("uses the built-in setTimeout backoff when sleepFn is omitted", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(prResponse({ state: "open" }))
      .mockResolvedValueOnce(prResponse({ state: "closed", merged: false, closed_at: "2026-07-12T01:00:00Z" }));

    // No sleepFn -> the real setTimeout-based default runs; minIntervalMs/maxIntervalMs pin the backoff to 1ms.
    const result = await pollPrDisposition("acme/widgets", 12, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 2,
      minIntervalMs: 1,
      maxIntervalMs: 1,
    });

    expect(result).toMatchObject({ state: "closed", merged: false, attempts: 2 });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("returns the last-observed open disposition once maxAttempts is exhausted, without throwing", async () => {
    const fetchFn = vi.fn(async () => prResponse({ state: "open" }));

    const result = await pollPrDisposition("acme/widgets", 11, {
      apiBaseUrl: API,
      fetchFn,
      maxAttempts: 2,
      sleepFn: vi.fn(),
    });

    expect(result).toEqual({ state: "open", merged: false, closedAt: null, attempts: 2 });
  });

  it("validates repo and PR number input before fetching", async () => {
    const fetchFn = vi.fn();
    await expect(pollPrDisposition("missing-slash", 1, { apiBaseUrl: API, fetchFn })).rejects.toThrow(
      "invalid_repo_full_name",
    );
    await expect(pollPrDisposition("acme/widgets", 0, { apiBaseUrl: API, fetchFn })).rejects.toThrow(
      "invalid_pr_number",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("surfaces a GitHub error response as a deterministic error", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({ message: "not found" }, { status: 404 }));
    await expect(pollPrDisposition("acme/widgets", 12, { apiBaseUrl: API, fetchFn })).rejects.toThrow(
      "github_404: not found",
    );
  });

  it("treats a malformed state as still-open rather than throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    const result = await pollPrDisposition("acme/widgets", 13, { apiBaseUrl: API, fetchFn });
    expect(result).toEqual({ state: "open", merged: false, closedAt: null, attempts: 1 });
  });

  it("bounds the request with a per-attempt AbortSignal timeout, defaulting to 10s (#miner-github-read-timeouts)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => prResponse({ state: "open" }));

    await pollPrDisposition("acme/widgets", 14, { apiBaseUrl: API, fetchFn });

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    const [, init] = fetchFn.mock.calls[0]!;
    expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    timeoutSpy.mockRestore();
  });

  it("honors a custom requestTimeoutMs instead of the 10s default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = vi.fn(async () => prResponse({ state: "open" }));

    await pollPrDisposition("acme/widgets", 15, { apiBaseUrl: API, fetchFn, requestTimeoutMs: 3000 });

    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    timeoutSpy.mockRestore();
  });
});

describe("classifyPrDisposition (#5135)", () => {
  it("classifies a merged PR as merged", () => {
    expect(classifyPrDisposition({ state: "closed", merged: true })).toBe("merged");
  });

  it("classifies a closed-unmerged PR as disengaged", () => {
    expect(classifyPrDisposition({ state: "closed", merged: false })).toBe("disengaged");
  });

  it("classifies a still-open PR as other", () => {
    expect(classifyPrDisposition({ state: "open", merged: false })).toBe("other");
  });
});
