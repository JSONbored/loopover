import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  fetchCandidateIssues,
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "../../packages/gittensory-miner/lib/opportunity-fanout.js";

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
      { apiBaseUrl: API },
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
    });

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "*", stage: "search", message: "GitHub returned 502" },
    ]);
  });
});
