import { describe, expect, it, vi } from "vitest";
import { classifyPrDisposition, pollPrDisposition } from "../../packages/gittensory-miner/lib/pr-disposition-poller.js";

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
