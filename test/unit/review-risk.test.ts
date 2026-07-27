import { describe, expect, it } from "vitest";
import { buildReviewRiskExplanation } from "../../src/signals/review-risk";
import type { IssueRecord, PullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return { repoFullName, number, title, state: "open", labels: [], linkedPrs: [], ...overrides };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return { repoFullName, number, title, state: "open", labels: [], linkedIssues: [], ...overrides };
}

// #9287: buildReviewRiskExplanation previously only had parity coverage (does the REST route match the
// MCP tool?) with no test asserting what each of its five recommendation branches actually resolves to.
describe("buildReviewRiskExplanation", () => {
  it("recommends likely_duplicate when a high-risk collision cluster is present", () => {
    const activeRepo = repo("acme/widgets");
    const dupIssue = issue(activeRepo.fullName, 100, "Duplicate work");
    const firstCandidate = pr(activeRepo.fullName, 101, "First candidate fix", { linkedIssues: [100] });
    const secondCandidate = pr(activeRepo.fullName, 102, "Second candidate fix", { linkedIssues: [100] });
    const result = buildReviewRiskExplanation({
      input: { repoFullName: activeRepo.fullName, title: "Third candidate fix", linkedIssues: [100] },
      repo: activeRepo,
      issues: [dupIssue],
      pullRequests: [firstCandidate, secondCandidate],
    });
    expect(result.recommendation).toBe("likely_duplicate");
    expect(result.summary).toBe(`LoopOver review-risk explanation for ${activeRepo.fullName}.`);
  });

  it("recommends maintainer_lane when the contributor login owns the repo", () => {
    const result = buildReviewRiskExplanation({
      input: { repoFullName: "acme/widgets", title: "Repo housekeeping", contributorLogin: "acme" },
      repo: null,
      issues: [],
      pullRequests: [],
    });
    expect(result.recommendation).toBe("maintainer_lane");
    expect(result.roleContext?.maintainerLane).toBe(true);
    expect(result.summary).toBe("LoopOver review-risk explanation for acme/widgets.");
  });

  it("recommends needs_author when preflight status is needs_work", () => {
    const activeRepo = repo("acme/widgets");
    const result = buildReviewRiskExplanation({
      input: { repoFullName: activeRepo.fullName, title: "Fix pagination", body: "Just a fix, no context." },
      repo: activeRepo,
      issues: [],
      pullRequests: [],
    });
    expect(result.preflight.status).toBe("needs_work");
    expect(result.recommendation).toBe("needs_author");
    expect(result.summary).toBe(`LoopOver review-risk explanation for ${activeRepo.fullName}.`);
  });

  it("recommends review when preflight status is ready", () => {
    const activeRepo = repo("acme/widgets");
    const result = buildReviewRiskExplanation({
      input: { repoFullName: activeRepo.fullName, title: "Fix pagination", body: "Fixes #1", linkedIssues: [1] },
      repo: activeRepo,
      issues: [],
      pullRequests: [],
    });
    expect(result.preflight.status).toBe("ready");
    expect(result.recommendation).toBe("review");
    expect(result.summary).toBe(`LoopOver review-risk explanation for ${activeRepo.fullName}.`);
  });

  it("recommends watch when the repo lane is unavailable and the author is not a maintainer", () => {
    const result = buildReviewRiskExplanation({
      input: { repoFullName: "missing/repo", title: "Docs note" },
      repo: null,
      issues: [],
      pullRequests: [],
    });
    expect(result.preflight.status).toBe("hold");
    expect(result.recommendation).toBe("watch");
    expect(result.roleContext).toBeNull();
    expect(result.summary).toBe("LoopOver review-risk explanation for missing/repo.");
  });
});
