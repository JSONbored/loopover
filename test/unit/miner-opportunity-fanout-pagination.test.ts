import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "../../packages/gittensory-miner/lib/opportunity-fanout.js";

const API = "https://api.test";
const TARGET = [{ owner: "acme", repo: "widgets" }];

type DiscoverOptions = {
  apiBaseUrl?: string;
  perPage?: number;
  maxPages?: number;
};

// checkJs infers a structurally narrow options type for the fan-out .js module, so pass a typed, non-fresh
// object rather than a fresh literal — the extra maxPages field is then accepted by structural assignment.
function discoverOptions(overrides: DiscoverOptions = {}): DiscoverOptions {
  return { apiBaseUrl: API, ...overrides };
}

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

function pagedResponse(body: unknown, nextUrl: string) {
  return jsonResponse(body, { headers: { link: `<${nextUrl}>; rel="next"` } });
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

const searchItem = (number: number) => ({
  ...issue(number),
  repository: { full_name: "acme/widgets" },
});

const pageParam = (url: string) => Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
const issuesNextUrl = (page: number) =>
  `${API}/repos/acme/widgets/issues?state=open&per_page=100&page=${page}`;
const searchNextUrl = (page: number) =>
  `${API}/search/issues?q=${encodeURIComponent("x state:open type:issue")}&per_page=100&page=${page}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery fanout Link-header pagination (#4831)", () => {
  it("follows the target-issues Link header across pages and returns every result", async () => {
    let issuesFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) {
        issuesFetches += 1;
        if (pageParam(url) === 2) return jsonResponse([issue(3)]);
        return pagedResponse([issue(1), issue(2)], issuesNextUrl(2));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "", discoverOptions());

    expect(issuesFetches).toBe(2);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);
  });

  it("stops target-issues pagination at maxPages even when a next link remains", async () => {
    let issuesFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) {
        issuesFetches += 1;
        const current = pageParam(url);
        return pagedResponse([issue(current)], issuesNextUrl(current + 1));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "", discoverOptions({ maxPages: 2 }));

    expect(issuesFetches).toBe(2);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1, 2]);
  });

  it("ignores target-issues Link headers that leave the configured API endpoint", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer github-token");
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) {
        return pagedResponse([issue(1)], "https://attacker.invalid/collect");
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "github-token", discoverOptions());

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(requestedUrls).not.toContain("https://attacker.invalid/collect");
  });

  it("ignores target-issues Link headers that switch endpoint paths", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) {
        return pagedResponse([issue(1)], `${API}/repos/acme/widgets/contents/AI-USAGE.md?page=2`);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "github-token", discoverOptions());

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(requestedUrls).not.toContain(`${API}/repos/acme/widgets/contents/AI-USAGE.md?page=2`);
  });

  it("follows the search Link header across pages and returns every item", async () => {
    let searchFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/search/issues?")) {
        searchFetches += 1;
        if (pageParam(url) === 2) return jsonResponse({ items: [searchItem(3)] });
        return pagedResponse({ items: [searchItem(1), searchItem(2)] }, searchNextUrl(2));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "", discoverOptions());

    expect(searchFetches).toBe(2);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1, 2, 3]);
    expect(result.warnings).toEqual([]);
  });

  it("stops search pagination at maxPages even when a next link remains", async () => {
    let searchFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/search/issues?")) {
        searchFetches += 1;
        const current = pageParam(url);
        return pagedResponse({ items: [searchItem(current)] }, searchNextUrl(current + 1));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "", discoverOptions({ maxPages: 2 }));

    expect(searchFetches).toBe(2);
    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1, 2]);
  });

  it("ignores search Link headers that leave the configured API endpoint", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe("Bearer github-token");
      if (url.includes("/search/issues?")) {
        return pagedResponse({ items: [searchItem(1)] }, "https://attacker.invalid/collect");
      }
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "github-token", discoverOptions());

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(requestedUrls).not.toContain("https://attacker.invalid/collect");
  });

  it("ignores search Link headers that use a non-HTTPS URL", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/search/issues?")) {
        return pagedResponse({ items: [searchItem(1)] }, "http://api.test/search/issues?page=2");
      }
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "github-token", discoverOptions());

    expect(result.issues.map((entry) => entry.issueNumber)).toEqual([1]);
    expect(requestedUrls).not.toContain("http://api.test/search/issues?page=2");
  });

  it("warns and returns what it has when a target-issues page is not an array", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) return jsonResponse({ unexpected: true });
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "", discoverOptions());

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "acme/widgets", stage: "issues", message: "GitHub returned a non-array issues payload" },
    ]);
  });

  it("warns and returns what it has when a target-issues fetch throws", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/contents/")) return jsonResponse({}, { status: 404 });
      if (url.includes("/issues?")) throw new Error("issues offline");
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await fetchCandidateIssuesWithSummary(TARGET, "", discoverOptions());

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "acme/widgets", stage: "issues", message: "issues offline" },
    ]);
  });

  it.each([
    ["a null payload", null],
    ["a non-object payload", 42],
    ["items that are not an array", { items: "nope" }],
  ])("warns and stops the search when GitHub returns %s", async (_label, body) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) return jsonResponse(body);
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "", discoverOptions());

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "*", stage: "search", message: "GitHub returned a non-array search payload" },
    ]);
  });

  it("warns and returns what it has when a search fetch throws", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/search/issues?")) throw new Error("search offline");
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await searchCandidateIssuesWithSummary("x", "", discoverOptions());

    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([
      { repoFullName: "*", stage: "search", message: "search offline" },
    ]);
  });
});
