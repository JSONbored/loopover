import { beforeEach, describe, expect, it } from "vitest";
import { DISCOVERY_INDEX_CONTRACT_VERSION, type AiPolicyVerdict, type DiscoveryIndexCandidate, type DiscoveryIndexQuery } from "@loopover/engine";
import { TtlCache } from "../../../packages/discovery-index/src/cache";
import { decodeCursor } from "../../../packages/discovery-index/src/cursor";
import { runDiscoveryQuery, type DiscoveryQueryDeps, type GitHubClientLike } from "../../../packages/discovery-index/src/discovery-query";
import type { GitHubIssue } from "../../../packages/discovery-index/src/github-client";
import { counterValue, resetMetrics } from "../../../packages/discovery-index/src/metrics";

const ALLOWED_AI_USAGE = "We welcome AI-assisted contributions.";
const BANNED_AI_USAGE = "No AI-generated pull requests are allowed.";

interface StubCall {
  method: "fetchRepoIssues" | "searchIssues" | "fetchRepoFile";
  args: unknown[];
}

interface StubConfig {
  issuesByRepo?: Record<string, GitHubIssue[]>;
  searchResults?: Record<string, GitHubIssue[]>;
  filesByRepo?: Record<string, Record<string, string | null>>;
}

function makeStubGitHub(config: StubConfig): { github: GitHubClientLike; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const github: GitHubClientLike = {
    async fetchRepoIssues(repoFullName: string) {
      calls.push({ method: "fetchRepoIssues", args: [repoFullName] });
      return { issues: config.issuesByRepo?.[repoFullName] ?? [], warnings: [] };
    },
    async searchIssues(query: string) {
      calls.push({ method: "searchIssues", args: [query] });
      return { issues: config.searchResults?.[query] ?? [], warnings: [] };
    },
    async fetchRepoFile(repoFullName: string, path: string) {
      calls.push({ method: "fetchRepoFile", args: [repoFullName, path] });
      const content = config.filesByRepo?.[repoFullName]?.[path] ?? null;
      return { content };
    },
  };
  return { github, calls };
}

function makeDeps(github: GitHubClientLike, cacheTtlMs = 300_000): DiscoveryQueryDeps {
  return {
    github,
    resultCache: new TtlCache<DiscoveryIndexCandidate[]>(),
    policyCache: new TtlCache<AiPolicyVerdict>(),
    cacheTtlMs,
  };
}

function query(overrides: Partial<DiscoveryIndexQuery> = {}): DiscoveryIndexQuery {
  return { repos: [], orgs: [], searchTerms: [], limit: 50, cursor: null, ...overrides };
}

describe("discovery-index runDiscoveryQuery (#7164)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("builds candidates from an allowed repo's issues, filtering PRs and invalid entries", async () => {
    const { github, calls } = makeStubGitHub({
      issuesByRepo: {
        "acme/widgets": [
          {
            number: 1,
            title: "Fix the thing",
            labels: ["bug", { name: "help wanted" }, { name: "  " }, 5],
            comments: 3,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-02T00:00:00Z",
            html_url: "https://github.com/acme/widgets/issues/1",
          },
          { number: 2, title: "A PR, not an issue", pull_request: {} },
          { number: 0, title: "Invalid number" },
          { number: 3, title: "" },
          { number: 4, title: "No comments field, no dates" },
        ],
      },
      filesByRepo: { "acme/widgets": { "AI-USAGE.md": ALLOWED_AI_USAGE } },
    });
    const response = await runDiscoveryQuery(query({ repos: ["acme/widgets"] }), makeDeps(github));
    expect(response.contractVersion).toBe(DISCOVERY_INDEX_CONTRACT_VERSION);
    expect(response.candidates).toHaveLength(2);
    const first = response.candidates.find((c) => c.issueNumber === 1)!;
    expect(first).toMatchObject({
      owner: "acme",
      repo: "widgets",
      repoFullName: "acme/widgets",
      title: "Fix the thing",
      labels: ["bug", "help wanted"],
      commentsCount: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      htmlUrl: "https://github.com/acme/widgets/issues/1",
      aiPolicyAllowed: true,
      aiPolicySource: "AI-USAGE.md",
    });
    const fourth = response.candidates.find((c) => c.issueNumber === 4)!;
    expect(fourth).toMatchObject({ commentsCount: 0, createdAt: null, updatedAt: null, htmlUrl: null, labels: [] });
    expect(calls.filter((c) => c.method === "fetchRepoFile")).toHaveLength(1);
  });

  it("skips a repo entirely when its AI policy disallows contributions", async () => {
    const { github, calls } = makeStubGitHub({
      issuesByRepo: { "acme/banned": [{ number: 1, title: "Should never appear" }] },
      filesByRepo: { "acme/banned": { "AI-USAGE.md": BANNED_AI_USAGE } },
    });
    const response = await runDiscoveryQuery(query({ repos: ["acme/banned"] }), makeDeps(github));
    expect(response.candidates).toEqual([]);
    expect(calls.some((c) => c.method === "fetchRepoIssues")).toBe(false);
  });

  it("falls through to CONTRIBUTING.md when AI-USAGE.md is blank or absent", async () => {
    const { github: blankUsage } = makeStubGitHub({
      issuesByRepo: { "acme/a": [{ number: 1, title: "T" }] },
      filesByRepo: { "acme/a": { "AI-USAGE.md": "   ", "CONTRIBUTING.md": ALLOWED_AI_USAGE } },
    });
    const blankResponse = await runDiscoveryQuery(query({ repos: ["acme/a"] }), makeDeps(blankUsage));
    expect(blankResponse.candidates[0]?.aiPolicySource).toBe("CONTRIBUTING.md");

    const { github: absentUsage } = makeStubGitHub({
      issuesByRepo: { "acme/b": [{ number: 1, title: "T" }] },
      filesByRepo: { "acme/b": { "CONTRIBUTING.md": ALLOWED_AI_USAGE } },
    });
    const absentResponse = await runDiscoveryQuery(query({ repos: ["acme/b"] }), makeDeps(absentUsage));
    expect(absentResponse.candidates[0]?.aiPolicySource).toBe("CONTRIBUTING.md");
  });

  it("defaults to allowed with source none when neither policy doc exists", async () => {
    const { github } = makeStubGitHub({ issuesByRepo: { "acme/c": [{ number: 1, title: "T" }] } });
    const response = await runDiscoveryQuery(query({ repos: ["acme/c"] }), makeDeps(github));
    expect(response.candidates[0]).toMatchObject({ aiPolicyAllowed: true, aiPolicySource: "none" });
  });

  it("resolves org and search-term results via their repository_url, applying per-repo policy", async () => {
    const { github, calls } = makeStubGitHub({
      searchResults: {
        "org:acme state:open type:issue": [
          { number: 1, title: "From org", repository_url: "https://api.github.com/repos/acme/one" },
          { number: 2, title: "Malformed url", repository_url: "not-a-repo-url" },
          { number: 3, title: "Banned repo", repository_url: "https://api.github.com/repos/acme/banned" },
          { number: 4, title: "No repository_url field at all" },
        ],
        "flaky test state:open type:issue": [{ number: 9, title: "From search term", repository_url: "https://api.github.com/repos/acme/one" }],
      },
      filesByRepo: {
        "acme/one": { "AI-USAGE.md": ALLOWED_AI_USAGE },
        "acme/banned": { "AI-USAGE.md": BANNED_AI_USAGE },
      },
    });
    const response = await runDiscoveryQuery(query({ orgs: ["acme"], searchTerms: ["flaky test"] }), makeDeps(github));
    // #1 (org) and #9 (search term) both resolve to acme/one; #2 is dropped (malformed url); #3 is dropped (banned).
    expect(response.candidates.map((c) => c.issueNumber).sort()).toEqual([1, 9]);
    expect(calls.some((c) => c.method === "searchIssues" && c.args[0] === "org:acme state:open type:issue")).toBe(true);
    expect(calls.some((c) => c.method === "searchIssues" && c.args[0] === "flaky test state:open type:issue")).toBe(true);
    // acme/one's policy is resolved once and reused across both the org and search-term hits.
    expect(calls.filter((c) => c.method === "fetchRepoFile" && c.args[0] === "acme/one")).toHaveLength(1);
  });

  it("sorts candidates across different repos alphabetically by repoFullName", async () => {
    const { github } = makeStubGitHub({
      issuesByRepo: {
        "zeta/repo": [{ number: 1, title: "Z" }],
        "alpha/repo": [{ number: 1, title: "A" }],
      },
    });
    const response = await runDiscoveryQuery(query({ repos: ["zeta/repo", "alpha/repo"] }), makeDeps(github));
    expect(response.candidates.map((c) => c.repoFullName)).toEqual(["alpha/repo", "zeta/repo"]);
  });

  it("dedupes the same issue reached via both a direct repo and a search result", async () => {
    const { github } = makeStubGitHub({
      issuesByRepo: { "acme/one": [{ number: 1, title: "Direct" }] },
      searchResults: {
        "acme state:open type:issue": [{ number: 1, title: "Via search", repository_url: "https://api.github.com/repos/acme/one" }],
      },
      filesByRepo: { "acme/one": { "AI-USAGE.md": ALLOWED_AI_USAGE } },
    });
    const response = await runDiscoveryQuery(query({ repos: ["acme/one"], searchTerms: ["acme"] }), makeDeps(github));
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.title).toBe("Direct"); // repos are processed before searchTerms; first write wins.
  });

  it("paginates a cached result set across two requests without re-hitting GitHub", async () => {
    const { github, calls } = makeStubGitHub({
      issuesByRepo: {
        "acme/many": [
          { number: 1, title: "One" },
          { number: 2, title: "Two" },
          { number: 3, title: "Three" },
        ],
      },
    });
    const deps = makeDeps(github);
    const page1 = await runDiscoveryQuery(query({ repos: ["acme/many"], limit: 2, cursor: null }), deps);
    expect(page1.candidates.map((c) => c.issueNumber)).toEqual([1, 2]);
    expect(page1.nextCursor).not.toBeNull();
    expect(decodeCursor(page1.nextCursor)).toBe(2);

    const page2 = await runDiscoveryQuery(query({ repos: ["acme/many"], limit: 2, cursor: page1.nextCursor }), deps);
    expect(page2.candidates.map((c) => c.issueNumber)).toEqual([3]);
    expect(page2.nextCursor).toBeNull();

    expect(calls.filter((c) => c.method === "fetchRepoIssues")).toHaveLength(1);
  });

  it("recomputes the candidate set once the result cache TTL expires", async () => {
    let now = 0;
    const github: GitHubClientLike = {
      async fetchRepoIssues() {
        return { issues: [{ number: 1, title: "T" }], warnings: [] };
      },
      async searchIssues() {
        return { issues: [], warnings: [] };
      },
      async fetchRepoFile() {
        return { content: null };
      },
    };
    let fetchCalls = 0;
    const wrapped: GitHubClientLike = {
      ...github,
      fetchRepoIssues: async (repoFullName: string) => {
        fetchCalls += 1;
        return github.fetchRepoIssues(repoFullName);
      },
    };
    const deps: DiscoveryQueryDeps = {
      github: wrapped,
      resultCache: new TtlCache<DiscoveryIndexCandidate[]>(() => now),
      policyCache: new TtlCache<AiPolicyVerdict>(() => now),
      cacheTtlMs: 100,
    };
    await runDiscoveryQuery(query({ repos: ["acme/x"] }), deps);
    expect(fetchCalls).toBe(1);
    await runDiscoveryQuery(query({ repos: ["acme/x"] }), deps);
    expect(fetchCalls).toBe(1); // within TTL, cache hit
    now += 200;
    await runDiscoveryQuery(query({ repos: ["acme/x"] }), deps);
    expect(fetchCalls).toBe(2); // TTL expired, recomputed
  });

  it("returns an empty response for an empty query scope without calling GitHub", async () => {
    const { github, calls } = makeStubGitHub({});
    const response = await runDiscoveryQuery(query(), makeDeps(github));
    expect(response).toEqual({ contractVersion: DISCOVERY_INDEX_CONTRACT_VERSION, candidates: [], nextCursor: null });
    expect(calls).toEqual([]);
  });

  it("records a result-cache miss then a hit on a repeated identical query scope", async () => {
    const { github } = makeStubGitHub({
      issuesByRepo: { "acme/one": [{ number: 1, title: "T" }] },
      filesByRepo: { "acme/one": { "AI-USAGE.md": ALLOWED_AI_USAGE } },
    });
    const deps = makeDeps(github);

    await runDiscoveryQuery(query({ repos: ["acme/one"] }), deps);
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "result", outcome: "miss" })).toBe(1);
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "result", outcome: "hit" })).toBe(0);

    await runDiscoveryQuery(query({ repos: ["acme/one"] }), deps);
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "result", outcome: "miss" })).toBe(1);
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "result", outcome: "hit" })).toBe(1);
  });

  it("records a policy-cache miss then a hit when the same repo's policy is resolved twice", async () => {
    // acme/one is reached via both the org search (#1) and the search term (#9); its policy is computed
    // once (miss) then reused (hit) within the same query.
    const { github } = makeStubGitHub({
      searchResults: {
        "org:acme state:open type:issue": [{ number: 1, title: "Org", repository_url: "https://api.github.com/repos/acme/one" }],
        "flaky state:open type:issue": [{ number: 9, title: "Term", repository_url: "https://api.github.com/repos/acme/one" }],
      },
      filesByRepo: { "acme/one": { "AI-USAGE.md": ALLOWED_AI_USAGE } },
    });
    await runDiscoveryQuery(query({ orgs: ["acme"], searchTerms: ["flaky"] }), makeDeps(github));
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "policy", outcome: "miss" })).toBe(1);
    expect(counterValue("discovery_index_cache_lookups_total", { cache: "policy", outcome: "hit" })).toBe(1);
  });
});
