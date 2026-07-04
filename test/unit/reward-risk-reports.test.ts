import { describe, expect, it } from "vitest";
import {
  buildMaintainerNoiseReport,
  buildPullRequestReviewability,
} from "../../src/signals/reward-risk";
import {
  buildContributorOutcomeHistory,
  buildContributorProfile,
  type ContributorOutcomeHistory,
} from "../../src/signals/engine";
import type {
  CheckSummaryRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistryRepoConfig,
  RepositoryRecord,
} from "../../src/types";

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function pr(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<PullRequestRecord> = {},
): PullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedIssues: [],
    body: "",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function issue(
  repoFullName: string,
  number: number,
  title: string,
  overrides: Partial<IssueRecord> = {},
): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "issue body",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFiles(count: number, pathPrefix = "src/file", additions = 10): PullRequestFileRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    repoFullName: "JSONbored/gittensory",
    pullNumber: 1,
    path: `${pathPrefix}-${i}.ts`,
    additions,
    deletions: 0,
    changes: additions,
    payload: {},
  }));
}

function failingCheck(pullNumber: number, name = "ci"): CheckSummaryRecord {
  return {
    id: `${name}-1`,
    repoFullName: "JSONbored/gittensory",
    pullNumber,
    name,
    status: "completed",
    conclusion: "failure",
    payload: {},
  };
}

describe("buildMaintainerNoiseReport (#2093)", () => {
  it("falls back to the empty-noise message when no source fires", () => {
    const r = repo("JSONbored/gittensory");
    const report = buildMaintainerNoiseReport(r, [], [], [], r.fullName);
    expect(report.repoFullName).toBe(r.fullName);
    expect(typeof report.generatedAt).toBe("string");
    expect(report.noiseSources).toEqual(["No major maintainer-noise source detected in cached metadata."]);
    expect(report.maintainerActions).toEqual(["watch"]);
    expect(["low", "medium", "high", "critical"]).toContain(report.level);
  });

  it("reports the unlinked open PR arm and the three level thresholds", () => {
    const r = repo("JSONbored/gittensory");
    const makeUnlinked = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        pr(r.fullName, 200 + i, `Focused fix ${i}`, { linkedIssues: [], updatedAt: new Date().toISOString() }),
      );
    expect(buildMaintainerNoiseReport(r, [], makeUnlinked(3), [], r.fullName).level).toBe("medium");
    expect(buildMaintainerNoiseReport(r, [], makeUnlinked(5), [], r.fullName).level).toBe("high");
    expect(buildMaintainerNoiseReport(r, [], makeUnlinked(8), [], r.fullName).level).toBe("critical");
    expect(buildMaintainerNoiseReport(r, [], makeUnlinked(1), [], r.fullName).noiseSources[0]).toMatch(/lack linked issue context/);
  });

  it("reports the high-risk collision cluster arm", () => {
    const r = repo("JSONbored/gittensory");
    const relatedIssue = issue(r.fullName, 1, "Fix cache bug");
    const collidingPr = pr(r.fullName, 100, "Fix cache bug duplicate", { linkedIssues: [1] });
    const recentMerged: RecentMergedPullRequestRecord[] = [
      { repoFullName: r.fullName, number: 99, title: "Fix cache bug", authorLogin: "x", mergedAt: "2026-01-01T00:00:00Z", labels: [], linkedIssues: [1], changedFiles: [], payload: {} },
    ];
    const report = buildMaintainerNoiseReport(r, [relatedIssue], [collidingPr], recentMerged, r.fullName);
    expect(report.noiseSources.some((s) => /high-risk duplicate\/WIP cluster/.test(s))).toBe(true);
    expect(report.maintainerActions).toContain("likely_duplicate");
  });

  it("reports the stale PR arm", () => {
    const r = repo("JSONbored/gittensory");
    const stale = pr(r.fullName, 50, "Old PR", {
      linkedIssues: [],
      updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const report = buildMaintainerNoiseReport(r, [], [stale], [], r.fullName);
    expect(report.noiseSources.some((s) => /stale PR/.test(s))).toBe(true);
    expect(report.maintainerActions).toContain("needs_author");
  });

  it("reports the broad-diff title arm", () => {
    const r = repo("JSONbored/gittensory");
    const broad = pr(r.fullName, 60, "Refactor and cleanup of various modules across the codebase".padEnd(140, " x"), {
      linkedIssues: [],
    });
    const report = buildMaintainerNoiseReport(r, [], [broad], [], r.fullName);
    expect(report.noiseSources.some((s) => /broad or hard to triage/.test(s))).toBe(true);
  });

  it("excludes already-merged/closed broad-title PRs from the broad-diff noise arm (only open PRs are live noise)", () => {
    const r = repo("JSONbored/gittensory");
    // A merged and a closed PR whose titles hit the churn regex must NOT be counted as live queue noise.
    const merged = pr(r.fullName, 61, "Refactor cleanup of various modules", { state: "merged" });
    const closed = pr(r.fullName, 62, "Misc cleanup", { state: "closed" });
    expect(buildMaintainerNoiseReport(r, [], [merged, closed], [], r.fullName).noiseSources.some((s) => /broad or hard to triage/.test(s))).toBe(false);
    // With one open broad PR alongside the two non-open ones, only the open PR is counted (1, not 3).
    const open = pr(r.fullName, 63, "Refactor cleanup various", { state: "open" });
    const mixed = buildMaintainerNoiseReport(r, [], [open, merged, closed], [], r.fullName);
    expect(mixed.noiseSources.some((s) => /^1 PR\(s\) look broad or hard to triage/.test(s))).toBe(true);
  });

  it("reports the strained intake arm via deduped maintainerActions", () => {
    const r = repo("JSONbored/gittensory", { issueDiscoveryShare: 0 });
    const unlinked = Array.from({ length: 4 }, (_, i) =>
      pr(r.fullName, 300 + i, `Open ${i}`, { linkedIssues: [], updatedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString() }),
    );
    const report = buildMaintainerNoiseReport(r, [], unlinked, [], r.fullName);
    expect(report.noiseSources.some((s) => /Contributor intake is (strained|blocked)/.test(s))).toBe(true);
    const uniq = new Set(report.maintainerActions);
    expect(uniq.size).toBe(report.maintainerActions.length);
    expect(report.maintainerActions).toContain("needs_author");
  });
});

function closedRateHistory(login: string, r: RepositoryRecord, closed: number, merged: number): ContributorOutcomeHistory {
  const profile = buildContributorProfile(login, { login, topLanguages: ["TypeScript"], source: "github" }, [], []);
  const pullRequests = [
    ...Array.from({ length: closed }, (_, i) => pr(r.fullName, 500 + i, `Closed ${i}`, { state: "closed", authorLogin: login })),
    ...Array.from({ length: merged }, (_, i) => pr(r.fullName, 600 + i, `Merged ${i}`, { state: "merged", mergedAt: "2026-05-20T00:00:00Z", authorLogin: login })),
  ];
  return buildContributorOutcomeHistory({ login, profile, repositories: [r], pullRequests, issues: [], repoStats: [] });
}

describe("buildPullRequestReviewability (#2093)", () => {
  it("returns the empty-blocker fallback and review_now action with approval", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 1, "Patch integration helper", {
      linkedIssues: [42],
      authorLogin: "dev",
    });
    const approvals: PullRequestReviewRecord[] = [
      { id: "rev-1", repoFullName: r.fullName, pullNumber: 1, reviewerLogin: "maintainer", state: "APPROVED", authorAssociation: "MEMBER", payload: {} },
    ];
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 1, path: "src/cache.test.ts", additions: 5, deletions: 1, changes: 6, payload: {} }],
      reviews: approvals,
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 1,
    });
    expect(typeof result.generatedAt).toBe("string");
    expect(result.action).toBe("review_now");
    expect(result.whyThisHelps).toEqual(expect.arrayContaining([expect.stringMatching(/Reviewing now is efficient/)]));
    expect(result.noiseSources).toEqual(["No major reviewability blocker detected in cached metadata."]);
    expect(result.privateSummary).toMatch(/Reviewability \d+\/100; action review_now/);
  });

  it("reports the missing-linked-issue arm and picks needs_author action", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 20, "Small unlinked code fix", { linkedIssues: [], updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 20, path: "src/cache.ts", additions: 10, deletions: 1, changes: 11, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 20,
    });
    expect(result.noiseSources).toEqual(expect.arrayContaining([expect.stringMatching(/Missing linked issue/)]));
    expect(result.action).toBe("needs_author");
    expect(result.whyThisHelps.some((w) => /Asking for author cleanup first/.test(w))).toBe(true);
  });

  it("reports the non-open PR arm and picks close_or_redirect action", () => {
    const r = repo("JSONbored/gittensory");
    const closed = pr(r.fullName, 21, "Closed broad PR", { state: "closed", linkedIssues: [], updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: closed,
      issues: [],
      pullRequests: [closed],
      files: [{ repoFullName: r.fullName, pullNumber: 21, path: "src/cache.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 21,
    });
    expect(result.noiseSources.some((s) => /PR is closed/.test(s))).toBe(true);
    expect(result.action).toBe("close_or_redirect");
    expect(result.whyThisHelps.some((w) => /Closed or non-open PRs should be redirected/.test(w))).toBe(true);
  });

  it("reports the maintainer_lane action when the PR author is the repo owner", () => {
    const r = repo("JSONbored/gittensory");
    const ownerPr = pr(r.fullName, 30, "Owner follow-up", { authorLogin: "JSONbored", linkedIssues: [], updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: ownerPr,
      issues: [],
      pullRequests: [ownerPr],
      files: [{ repoFullName: r.fullName, pullNumber: 30, path: "src/cache.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 30,
    });
    expect(result.action).toBe("maintainer_lane");
    expect(result.whyThisHelps.some((w) => /repo stewardship/.test(w))).toBe(true);
  });

  it("reports the collision-cluster arm and picks likely_duplicate action", () => {
    const r = repo("JSONbored/gittensory");
    const relatedIssue = issue(r.fullName, 5, "Fix cache invalidation");
    const targetPr = pr(r.fullName, 40, "Fix cache invalidation", { linkedIssues: [5], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const recentMerged: RecentMergedPullRequestRecord[] = [
      { repoFullName: r.fullName, number: 38, title: "Fix cache invalidation", authorLogin: "x", mergedAt: "2026-01-01T00:00:00Z", labels: [], linkedIssues: [5], changedFiles: [], payload: {} },
    ];
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: targetPr,
      issues: [relatedIssue],
      pullRequests: [targetPr],
      files: [{ repoFullName: r.fullName, pullNumber: 40, path: "src/cache.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: recentMerged,
      repoFullName: r.fullName,
      pullNumber: 40,
    });
    expect(result.noiseSources.some((s) => /duplicate\/WIP collision cluster/.test(s))).toBe(true);
    expect(result.action).toBe("likely_duplicate");
    expect(result.whyThisHelps.some((w) => /Checking overlap first/.test(w))).toBe(true);
  });

  it("reports the code-without-test arm when only non-test files changed", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 50, "Refactor cache", { linkedIssues: [9], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [issue(r.fullName, 9, "Refactor cache")],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 50, path: "src/cache.ts", additions: 20, deletions: 2, changes: 22, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 50,
    });
    expect(result.noiseSources.some((s) => /Code changes do not include cached test files/.test(s))).toBe(true);
  });

  it("reports the failing-checks arm", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 60, "WIP", { linkedIssues: [], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 60, path: "src/cache.test.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [failingCheck(60)],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 60,
    });
    expect(result.noiseSources.some((s) => /failing or cancelled check/.test(s))).toBe(true);
  });

  it("reports the broad-diff arm at fileCount >= 12 and at additions+deletions >= 800", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 70, "Wide refactor", { linkedIssues: [], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const eleven = makeFiles(11);
    const twelve = makeFiles(12);
    expect(
      buildPullRequestReviewability({
        repo: r,
        pullRequest: p,
        issues: [],
        pullRequests: [p],
        files: eleven,
        reviews: [],
        checks: [],
        recentMergedPullRequests: [],
        repoFullName: r.fullName,
        pullNumber: 70,
      }).noiseSources.some((s) => /Diff is broad enough/.test(s)),
    ).toBe(false);
    expect(
      buildPullRequestReviewability({
        repo: r,
        pullRequest: p,
        issues: [],
        pullRequests: [p],
        files: twelve,
        reviews: [],
        checks: [],
        recentMergedPullRequests: [],
        repoFullName: r.fullName,
        pullNumber: 70,
      }).noiseSources.some((s) => /Diff is broad enough/.test(s)),
    ).toBe(true);
    const sevenNinetyNine = [{ repoFullName: r.fullName, pullNumber: 70, path: "src/big.ts", additions: 799, deletions: 0, changes: 799, payload: {} }];
    expect(
      buildPullRequestReviewability({
        repo: r,
        pullRequest: p,
        issues: [],
        pullRequests: [p],
        files: sevenNinetyNine,
        reviews: [],
        checks: [],
        recentMergedPullRequests: [],
        repoFullName: r.fullName,
        pullNumber: 70,
      }).noiseSources.some((s) => /Diff is broad enough/.test(s)),
    ).toBe(false);
    const eightHundred = [{ repoFullName: r.fullName, pullNumber: 70, path: "src/big.ts", additions: 800, deletions: 0, changes: 800, payload: {} }];
    expect(
      buildPullRequestReviewability({
        repo: r,
        pullRequest: p,
        issues: [],
        pullRequests: [p],
        files: eightHundred,
        reviews: [],
        checks: [],
        recentMergedPullRequests: [],
        repoFullName: r.fullName,
        pullNumber: 70,
      }).noiseSources.some((s) => /Diff is broad enough/.test(s)),
    ).toBe(true);
  });

  it("reports the high closed-PR-rate arm and falls to watch action", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 80, "Another try", { linkedIssues: [], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const outcomeHistory = closedRateHistory("dev", r, 4, 1);
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 80, path: "src/cache.test.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 80,
      outcomeHistory,
    });
    expect(result.noiseSources.some((s) => /Contributor repo-specific closed PR rate/.test(s))).toBe(true);
    expect(["watch", "needs_author", "likely_duplicate"]).toContain(result.action);
  });

  it("exposes generatedAt and summary shape without leaking private score internals to public fields", () => {
    const r = repo("JSONbored/gittensory");
    const p = pr(r.fullName, 90, "Shape check", { linkedIssues: [], authorLogin: "dev", updatedAt: new Date().toISOString() });
    const result = buildPullRequestReviewability({
      repo: r,
      pullRequest: p,
      issues: [],
      pullRequests: [p],
      files: [{ repoFullName: r.fullName, pullNumber: 90, path: "src/cache.test.ts", additions: 5, deletions: 0, changes: 5, payload: {} }],
      reviews: [],
      checks: [],
      recentMergedPullRequests: [],
      repoFullName: r.fullName,
      pullNumber: 90,
    });
    const publicKeys = Object.keys(result).sort();
    expect(publicKeys).toEqual(
      [
        "action",
        "generatedAt",
        "maintainerNextSteps",
        "noiseSources",
        "privateSummary",
        "pullNumber",
        "repoFullName",
        "score",
        "whyThisHelps",
      ].sort(),
    );
    expect(result.maintainerNextSteps.length).toBeGreaterThan(0);
  });
});