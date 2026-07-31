import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  fetchCandidateIssues,
  fetchCandidateIssuesWithSummary,
  searchCandidateIssues,
  searchCandidateIssuesWithSummary,
} from "../../packages/loopover-miner/lib/opportunity-fanout";

const API = "https://api.test";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1800000000",
      ...(init.headers ?? {}),
    },
  });
}

function contentResponse(content: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

const issue = (number: number, title = `Issue ${number}`) => ({
  number,
  title,
  labels: [{ name: "help wanted" }, "good first issue", { missing: true }],
  comments: 2,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T01:00:00Z",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCandidateIssues (#2307)", () => {
  it("lists open issue metadata for allowed repos and excludes pull requests", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      authorization: string | null | undefined;
    }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method,
        authorization:
          init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : (init?.headers as Record<string, string> | undefined)?.authorization,
      });
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Please add tests.");
      if (url.includes("/issues?")) return jsonResponse([issue(7), { ...issue(8), pull_request: {} }]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "placeholder-token", {
      apiBaseUrl: API,
    });

    expect(result).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        repoFullName: "acme/widgets",
        issueNumber: 7,
        title: "Issue 7",
        labels: ["help wanted", "good first issue"],
        assignees: [],
        commentsCount: 2,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-01T01:00:00Z",
        htmlUrl: "https://github.com/acme/widgets/issues/7",
        aiPolicyAllowed: true,
        aiPolicySource: "CONTRIBUTING.md",
      },
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.every((call) => call.authorization === "Bearer placeholder-token")).toBe(true);
  });

  it("maps assignee logins from the same issue payload, ignoring a malformed entry (#7040)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) {
        return jsonResponse([
          {
            ...issue(9),
            assignees: [{ login: "repo-owner" }, { missing: true }, "not-an-object"],
          },
        ]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "placeholder-token", {
      apiBaseUrl: API,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.assignees).toEqual(["repo-owner"]);
  });

  it("hard-skips a banned repo without listing issues", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/contents/AI-USAGE.md")) return contentResponse("No AI-generated pull requests.");
      throw new Error("banned repo should not list issues");
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "banned" }], "", {
      apiBaseUrl: API,
    });

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/repos/acme/banned/contents/AI-USAGE.md");
  });

  it("does not let a blank AI-USAGE.md swallow an AI ban in CONTRIBUTING.md", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/contents/AI-USAGE.md")) return contentResponse("   "); // exists but blank/whitespace
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("No AI-generated pull requests.");
      if (url.includes("/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "banned" }], "", { apiBaseUrl: API });

    // The ban in CONTRIBUTING.md must win, and it must actually be consulted (not skipped by the blank AI-USAGE.md).
    expect(result).toEqual([]);
    expect(calls.some((url) => url.endsWith("/contents/CONTRIBUTING.md"))).toBe(true);
    // Fail closed: a banned repo's issues are never listed.
    expect(calls.some((url) => url.includes("/issues?"))).toBe(false);
  });

  it("fans out allowed repos while banned repos contribute no issue calls", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) {
        return contentResponse("AI-generated PRs are rejected.");
      }
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("AI work is reviewed normally.");
      if (url.includes("/repos/acme/allowed/issues?")) return jsonResponse([issue(3)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues(
      [
        { owner: "acme", repo: "banned" },
        { owner: "acme", repo: "allowed" },
      ],
      "token",
      { apiBaseUrl: API },
    );

    expect(result.map((entry) => entry.repoFullName)).toEqual(["acme/allowed"]);
    expect(calls.some((url) => url.includes("/repos/acme/banned/issues?"))).toBe(false);
    expect(calls.some((url) => url.includes("/repos/acme/allowed/issues?"))).toBe(true);
  });

  it("degrades a failing target to an empty list while preserving other targets and rate-limit telemetry", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/repos/acme/down/issues?")) {
        return jsonResponse(
          { message: "server error" },
          { status: 503, headers: { "x-ratelimit-remaining": "9", "x-ratelimit-reset": "1800000300" } },
        );
      }
      if (url.includes("/repos/acme/up/issues?")) return jsonResponse([issue(11)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary(
      [
        { owner: "acme", repo: "down" },
        { owner: "acme", repo: "up" },
      ],
      "token",
      { apiBaseUrl: API, sleepFn: () => Promise.resolve() }, // instant retry: a persistent 503 still warns
    );

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([11]);
    expect(result.warnings).toEqual([
      { repoFullName: "acme/down", stage: "issues", message: "GitHub returned 503" },
    ]);
    expect(result.rateLimitRemaining).toBe(9);
    expect(result.rateLimitResetAt).toBe("2027-01-15T08:05:00.000Z");
  });

  it("bounds concurrent target workers", async () => {
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal("fetch", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return contentResponse("No AI-generated pull requests.");
    });

    await fetchCandidateIssuesWithSummary(
      [
        { owner: "acme", repo: "one" },
        { owner: "acme", repo: "two" },
        { owner: "acme", repo: "three" },
      ],
      "",
      { apiBaseUrl: API, concurrency: 2 },
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("deduplicates malformed and repeated targets before fetching", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return contentResponse("No AI-generated pull requests.");
    });

    await fetchCandidateIssues(
      [
        { owner: "", repo: "missing-owner" },
        { owner: "acme", repo: "widgets" },
        { owner: "ACME", repo: "widgets" },
      ],
      "",
      { apiBaseUrl: API },
    );

    expect(calls).toHaveLength(1);
  });

  it("searches open issue metadata and applies the AI-policy hard-skip per repo", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/search/issues?")) {
        return jsonResponse({
          items: [
            {
              ...issue(21, "Search result"),
              repository: { full_name: "acme/allowed" },
              html_url: "https://github.com/acme/allowed/issues/21",
            },
            {
              ...issue(22, "HTML fallback"),
              repository: {},
              repository_url: undefined,
              html_url: "https://github.com/acme/allowed/issues/22",
            },
            {
              ...issue(23, "Banned result"),
              repository_url: `${API}/repos/acme/banned`,
              html_url: "https://github.com/acme/banned/issues/23",
            },
            {
              ...issue(24, "Pull request result"),
              repository: { full_name: "acme/allowed" },
              pull_request: {},
            },
          ],
        });
      }
      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) {
        return contentResponse("No AI-generated pull requests.");
      }
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      throw new Error(`unexpected fanout request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("label:help-wanted", "token", {
      apiBaseUrl: API,
      perPage: 25,
    });

    expect(result.issues.map((entry) => [entry.repoFullName, entry.issueNumber])).toEqual([
      ["acme/allowed", 21],
      ["acme/allowed", 22],
    ]);
    expect(result.warnings).toEqual([]);
    expect(calls[0]).toBe(
      `${API}/search/issues?q=${encodeURIComponent("label:help-wanted state:open type:issue")}&per_page=25`,
    );
    expect(calls.filter((url) => url.includes("/repos/acme/allowed/contents/AI-USAGE.md"))).toHaveLength(
      1,
    );
    expect(calls.some((url) => url.includes("/repos/acme/banned/issues?"))).toBe(false);
    expect(calls.some((url) => url.includes("/repos/acme/allowed/issues?"))).toBe(false);
  });

  it("degrades a failed search query to an empty result with a warning", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ message: "bad gateway" }, { status: 502 }));

    const result = await searchCandidateIssuesWithSummary("label:feature", "token", {
      apiBaseUrl: API,
      sleepFn: () => Promise.resolve(), // instant retry: a persistent 502 still warns
    });

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "*", stage: "search", message: "GitHub returned 502" },
    ]);
  });

  it("retries a transient 5xx and keeps the target's issues instead of dropping them (#4830)", async () => {
    let issuesAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/repos/acme/blip/issues?")) {
        issuesAttempts += 1;
        if (issuesAttempts === 1) return jsonResponse({ message: "server error" }, { status: 503 }); // a blip
        return jsonResponse([issue(7)]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "blip" }], "token", {
      apiBaseUrl: API,
      sleepFn: () => Promise.resolve(),
    });

    expect(issuesAttempts).toBe(2); // the 503 was retried, then succeeded
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([7]); // results kept, not dropped
    expect(result.warnings).toEqual([]); // no warning — the transient blip recovered
  });

  it("bounds every GitHub request with a per-attempt AbortSignal timeout, defaulting to 10s (#miner-github-read-timeouts)", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/repos/acme/blip/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "blip" }], "token", { apiBaseUrl: API });

    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3); // AI-USAGE.md + CONTRIBUTING.md + issues
    expect(timeoutSpy.mock.calls.length).toBe(fetchSpy.mock.calls.length);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    for (const [, init] of fetchSpy.mock.calls) {
      expect((init as RequestInit | undefined)?.signal).toBeInstanceOf(AbortSignal);
    }
    timeoutSpy.mockRestore();
  });

  it("honors a custom requestTimeoutMs instead of the 10s default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/repos/acme/blip/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "blip" }], "token", {
      apiBaseUrl: API,
      requestTimeoutMs: 3000,
    });

    expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 3000)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("falls back to the 10s default when requestTimeoutMs is not finite", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/repos/acme/blip/issues?")) return jsonResponse([issue(7)]);
      return jsonResponse({}, { status: 404 });
    });

    await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "blip" }], "token", {
      apiBaseUrl: API,
      requestTimeoutMs: Number.NaN,
    });

    expect(timeoutSpy.mock.calls.length).toBeGreaterThan(0);
    expect(timeoutSpy.mock.calls.every(([ms]) => ms === 10_000)).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("tolerates non-array targets and malformed target entries, making zero requests for zero valid targets", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const fromNonArray = await fetchCandidateIssuesWithSummary("not-an-array" as never, "token", { apiBaseUrl: API });
    expect(fromNonArray.issues).toEqual([]);

    const fromMalformedEntries = await fetchCandidateIssuesWithSummary(
      [{ owner: 123, repo: null }, {}, { owner: "acme" }] as never,
      "token",
      { apiBaseUrl: API },
    );
    expect(fromMalformedEntries.issues).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("omits the Authorization header when githubToken is not a string", async () => {
    const authorizations: Array<string | null | undefined> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(
        init?.headers instanceof Headers
          ? init.headers.get("authorization")
          : (init?.headers as Record<string, string> | undefined)?.authorization,
      );
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) return jsonResponse([issue(1)]);
      return jsonResponse({}, { status: 404 });
    });

    await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], undefined as never, { apiBaseUrl: API });

    expect(authorizations.every((value) => value == null)).toBe(true);
  });

  it("tolerates a non-numeric x-ratelimit-remaining header (never records a NaN budget)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      // "unknown" -> Number("unknown") is NaN, so Number.isFinite(remaining) is false -- unlike a genuinely
      // ABSENT header, where headers.get() returns null and Number(null) is 0 (finite), not NaN.
      const headers = { "x-ratelimit-remaining": "unknown" };
      if (url.endsWith("/contents/AI-USAGE.md")) return Response.json({}, { status: 404, headers });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) return Response.json([issue(3)], { headers });
      return Response.json({}, { status: 404, headers });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    // CONTRIBUTING.md's response (contentResponse) DOES carry a real numeric remaining (42) -- proving the
    // "unknown" responses were skipped rather than poisoning the running minimum with NaN.
    expect(result.rateLimitRemaining).toBe(42);
  });

  it("#9678: an ABSENT x-ratelimit-remaining header records no budget (null), not 0", async () => {
    // A forge/proxy that omits the header: headers.get() is null and Number(null) is 0 (finite) -- before
    // #9678 this pinned rateLimitRemaining to 0 and serialized the whole fan-out against a budget never reported.
    const bareContent = () =>
      Response.json({ type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return Response.json({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return bareContent();
      if (url.includes("/issues?")) return Response.json([issue(3)]);
      return Response.json({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", { apiBaseUrl: API });

    expect(result.rateLimitRemaining).toBeNull();
  });

  it("#9678: a blank/whitespace-only x-ratelimit-remaining header is skipped (stays null), not recorded as 0", async () => {
    const headers = { "x-ratelimit-remaining": "   " };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return Response.json({}, { status: 404, headers });
      if (url.endsWith("/contents/CONTRIBUTING.md"))
        return Response.json({ type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") }, { headers });
      if (url.includes("/issues?")) return Response.json([issue(3)], { headers });
      return Response.json({}, { status: 404, headers });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", { apiBaseUrl: API });

    expect(result.rateLimitRemaining).toBeNull();
  });

  it("#9678: a genuinely-present '0' x-ratelimit-remaining is still recorded (real exhaustion is not lost)", async () => {
    const headers = { "x-ratelimit-remaining": "0" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return Response.json({}, { status: 404, headers });
      if (url.endsWith("/contents/CONTRIBUTING.md"))
        return Response.json({ type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") }, { headers });
      if (url.includes("/issues?")) return Response.json([issue(3)], { headers });
      return Response.json({}, { status: 404, headers });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", { apiBaseUrl: API });

    expect(result.rateLimitRemaining).toBe(0);
  });

  it("treats a malformed (array, not object) policy-doc payload as absent content, and passes through non-base64-encoded content unchanged", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      // A malformed AI-USAGE.md payload (array, not `{content, encoding}`) decodes to null content -> falls
      // through to CONTRIBUTING.md, whose content here is NOT base64-encoded (encoding: "none").
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse([1, 2, 3]);
      if (url.endsWith("/contents/CONTRIBUTING.md")) {
        return jsonResponse({ type: "file", encoding: "none", content: "Contributions welcome, AI included." });
      }
      if (url.includes("/issues?")) return jsonResponse([issue(5)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "token", { apiBaseUrl: API });

    expect(result.map((entry) => entry.issueNumber)).toEqual([5]);
    expect(result[0]?.aiPolicySource).toBe("CONTRIBUTING.md");
  });

  it("normalizes a non-Error thrown while fetching a policy doc to a generic warning message, still falling through", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) throw "boom"; // eslint-disable-line no-throw-literal -- deliberately non-Error
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) return jsonResponse([issue(9)]);
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    expect(result.warnings).toEqual([
      { repoFullName: "acme/widgets", stage: "policy:AI-USAGE.md", message: "policy fetch failed" },
    ]);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([9]);
  });

  it("normalizes a non-Error thrown while listing issues to a generic warning message", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) throw { code: "ECONNRESET" }; // eslint-disable-line no-throw-literal -- deliberately non-Error
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    expect(result.warnings).toEqual([{ repoFullName: "acme/widgets", stage: "issues", message: "issue fetch failed" }]);
  });

  it("drops malformed issue entries and defaults every optional field a minimal-but-valid entry omits", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) {
        return jsonResponse([
          { number: 0, title: "Invalid number (<= 0)" },
          { number: 5, title: "" }, // blank title
          { number: 6, title: "Minimal issue" }, // no labels/assignees/comments/created_at/updated_at/html_url
        ]);
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await fetchCandidateIssues([{ owner: "acme", repo: "widgets" }], "token", { apiBaseUrl: API });

    expect(result).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        repoFullName: "acme/widgets",
        issueNumber: 6,
        title: "Minimal issue",
        labels: [],
        assignees: [],
        commentsCount: 0,
        createdAt: null,
        updatedAt: null,
        htmlUrl: null,
        aiPolicyAllowed: true,
        aiPolicySource: "CONTRIBUTING.md",
      },
    ]);
  });

  it("returns no results for a blank/whitespace-only search query, without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await searchCandidateIssuesWithSummary("   ", "token", { apiBaseUrl: API });

    expect(result.issues).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns no results for a non-string search query, without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await searchCandidateIssuesWithSummary(undefined as never, "token", { apiBaseUrl: API });

    expect(result.issues).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes a non-Error thrown while searching to a generic warning message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw "search boom"; // eslint-disable-line no-throw-literal -- deliberately non-Error
    });

    const result = await searchCandidateIssuesWithSummary("label:bug", "token", { apiBaseUrl: API });

    expect(result.warnings).toEqual([{ repoFullName: "*", stage: "search", message: "issue search failed" }]);
  });

  it("resolves a search hit whose repository.full_name is malformed via its html_url fallback instead", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({
          items: [
            {
              ...issue(60),
              repository: { full_name: "no-slash-here" }, // malformed: no "/", falls through to html_url
              html_url: "https://github.com/acme/widgets/issues/60",
            },
          ],
        });
      }
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:bug", "token", { apiBaseUrl: API });

    expect(result.issues.map((entry) => [entry.repoFullName, entry.issueNumber])).toEqual([["acme/widgets", 60]]);
  });

  it("silently drops a search hit with no full_name, no matching repository_url, and no html_url at all", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({ items: [{ number: 61, title: "Unresolvable target" }] });
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:bug", "token", { apiBaseUrl: API });

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("searchCandidateIssues returns just the issues array, defaulting options when omitted", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse({ items: [{ ...issue(70), repository: { full_name: "acme/widgets" } }] });
      }
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssues("label:bug", "token");

    expect(result.map((entry) => entry.issueNumber)).toEqual([70]);
  });

  it("#10005: only folds a core-billed x-ratelimit-remaining into the summary, not the search bucket's", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse(
          { items: [{ ...issue(80), repository: { full_name: "acme/widgets" } }] },
          { headers: { "x-ratelimit-remaining": "29", "x-ratelimit-resource": "search" } },
        );
      }
      if (url.endsWith("/contents/AI-USAGE.md")) {
        return jsonResponse(
          { type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") },
          { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "core" } },
        );
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:help-wanted", "token", { apiBaseUrl: API });

    expect(result.rateLimitRemaining).toBe(4990);
  });

  it("#10005: rateLimitResetAt is likewise taken only from core-billed responses, not the search bucket's", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse(
          { items: [{ ...issue(81), repository: { full_name: "acme/widgets" } }] },
          {
            headers: {
              "x-ratelimit-remaining": "29",
              "x-ratelimit-resource": "search",
              "x-ratelimit-reset": "4000000000", // far future -- must not win
            },
          },
        );
      }
      if (url.endsWith("/contents/AI-USAGE.md")) {
        return jsonResponse(
          { type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") },
          { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "core", "x-ratelimit-reset": "1800000300" } },
        );
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:help-wanted", "token", { apiBaseUrl: API });

    expect(result.rateLimitResetAt).toBe("2027-01-15T08:05:00.000Z");
  });

  it("#10005: still records x-ratelimit-remaining when x-ratelimit-resource is absent (no forge regression)", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      const headers = { "x-ratelimit-remaining": "12" };
      if (url.endsWith("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404, headers });
      if (url.endsWith("/contents/CONTRIBUTING.md")) return contentResponse("Contributions welcome.");
      if (url.includes("/issues?")) return jsonResponse([issue(3)], { headers });
      return jsonResponse({}, { status: 404, headers });
    });

    const result = await fetchCandidateIssuesWithSummary([{ owner: "acme", repo: "widgets" }], "token", {
      apiBaseUrl: API,
    });

    expect(result.rateLimitRemaining).toBe(12);
  });

  it("REGRESSION: the search bucket's remaining budget does not pin the core fan-out to serial concurrency", async () => {
    const repos = ["one", "two", "three", "four", "five"];
    let activeContentsRequests = 0;
    let maxActiveContentsRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) {
        return jsonResponse(
          {
            items: repos.map((repo, index) => ({
              ...issue(90 + index, `Issue in ${repo}`),
              repository: { full_name: `acme/${repo}` },
              html_url: `https://github.com/acme/${repo}/issues/${90 + index}`,
            })),
          },
          { headers: { "x-ratelimit-remaining": "29", "x-ratelimit-resource": "search" } },
        );
      }
      if (url.includes("/contents/AI-USAGE.md")) {
        activeContentsRequests += 1;
        maxActiveContentsRequests = Math.max(maxActiveContentsRequests, activeContentsRequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeContentsRequests -= 1;
        return jsonResponse(
          { type: "file", encoding: "base64", content: Buffer.from("Contributions welcome.", "utf8").toString("base64") },
          { headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "core" } },
        );
      }
      return jsonResponse({}, { status: 404 });
    });

    const result = await searchCandidateIssuesWithSummary("label:help-wanted", "token", {
      apiBaseUrl: API,
      concurrency: 5,
    });

    // Before the #10005 fix, the search response's remaining:29 pinned rateLimitRemaining to 29 -- well under
    // discovery-throttle's default 50 low-water-mark -- so resolveThrottledConcurrency serialized every one of
    // these five policy-doc fetches to a single in-flight request regardless of the configured concurrency.
    expect(result.rateLimitRemaining).toBe(4990);
    expect(maxActiveContentsRequests).toBeGreaterThan(1);
  });
});
