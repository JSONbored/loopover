import { describe, expect, it } from "vitest";
import { buildPreStartCheck, type PreStartCheckReport } from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward|farming|raw trust|trust score|scoreability|reviewability/i;
const LONG_BODY = "This issue has a thorough description with reproduction steps, expected behaviour, actual behaviour, and enough surrounding context that the issue-quality report treats it as actionable rather than thin.";

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
      issueDiscoveryShare: 1,
      labelMultipliers: {},
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
      ...overrides,
    },
  };
}

function issue(number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: LONG_BODY,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function pr(number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: "owner/repo",
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

function mergedPr(number: number, title: string, overrides: Partial<RecentMergedPullRequestRecord> = {}): RecentMergedPullRequestRecord {
  return {
    repoFullName: "owner/repo",
    number,
    title,
    authorLogin: "solver",
    mergedAt: new Date().toISOString(),
    labels: [],
    linkedIssues: [],
    changedFiles: [],
    payload: {},
    ...overrides,
  };
}

function assertPublicSafe(report: PreStartCheckReport): void {
  for (const line of [...report.reasons, ...report.blockers, report.summary]) {
    expect(line).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  }
}

describe("buildPreStartCheck", () => {
  it("returns go for a clean, unclaimed, actionable issue", () => {
    const r = repo("owner/repo");
    const issues = [issue(1, "Fix parser crash on empty input handling")];
    const report = buildPreStartCheck(r, issues, [], [], "owner/repo", { issueNumber: 1 });
    expect(report.recommendation).toBe("go");
    expect(report.claimStatus).toBe("unclaimed");
    expect(report.found).toBe(true);
    expect(report.duplicateClusterRisk).toBe("none");
    expect(report.target.matchedBy).toBe("issue_number");
    expect(report.target.resolvedIssueNumber).toBe(1);
    expect(report.summary.startsWith("Go")).toBe(true);
    expect(report.reasons.length).toBeGreaterThan(0);
    assertPublicSafe(report);
  });

  it("avoids an issue already claimed by an open linked PR", () => {
    const r = repo("owner/repo");
    const issues = [issue(1, "Fix parser crash on empty input handling")];
    const prs = [pr(10, "Fix parser crash", { linkedIssues: [1] })];
    const report = buildPreStartCheck(r, issues, prs, [], "owner/repo", { issueNumber: 1 });
    expect(report.recommendation).toBe("avoid");
    expect(report.claimStatus).toBe("claimed");
    expect(report.issueQualityStatus).toBe("do_not_use");
    expect(report.blockers.some((b) => /already references this issue/i.test(b))).toBe(true);
    assertPublicSafe(report);
  });

  it("avoids an issue already solved by merged work", () => {
    const r = repo("owner/repo");
    const issues = [issue(2, "Improve retry backoff in the queue worker")];
    const merged = [mergedPr(20, "Improve retry backoff", { linkedIssues: [2] })];
    const report = buildPreStartCheck(r, issues, [], merged, "owner/repo", { issueNumber: 2 });
    expect(report.claimStatus).toBe("solved");
    expect(report.lifecycle).toBe("valid_solved");
    expect(report.recommendation).toBe("avoid");
    expect(report.blockers.some((b) => /merged or validated/i.test(b))).toBe(true);
    assertPublicSafe(report);
  });

  it("flags high duplicate-cluster risk when multiple PRs target one issue", () => {
    const r = repo("owner/repo");
    const issues = [issue(3, "Add pagination to the labels endpoint")];
    const prs = [pr(31, "Paginate labels", { linkedIssues: [3] }), pr(32, "Labels pagination", { linkedIssues: [3] })];
    const report = buildPreStartCheck(r, issues, prs, [], "owner/repo", { issueNumber: 3 });
    expect(report.duplicateClusterRisk).toBe("high");
    expect(report.recommendation).toBe("avoid");
    expect(report.blockers.some((b) => /high-risk duplicate/i.test(b))).toBe(true);
    assertPublicSafe(report);
  });

  it("avoids issues labelled duplicate or invalid", () => {
    const r = repo("owner/repo");
    const duplicate = buildPreStartCheck(r, [issue(4, "Crash on startup", { labels: ["duplicate"] })], [], [], "owner/repo", { issueNumber: 4 });
    expect(duplicate.lifecycle).toBe("duplicate");
    expect(duplicate.recommendation).toBe("avoid");
    expect(duplicate.blockers.some((b) => /duplicate in cached metadata/i.test(b))).toBe(true);

    const invalid = buildPreStartCheck(r, [issue(5, "Please add feature", { labels: ["wontfix"] })], [], [], "owner/repo", { issueNumber: 5 });
    expect(invalid.lifecycle).toBe("invalid");
    expect(invalid.recommendation).toBe("avoid");
    assertPublicSafe(duplicate);
    assertPublicSafe(invalid);
  });

  it("avoids duplicate targets beyond the 300-issue lifecycle cap (regression for pinned lifecycle lookup)", () => {
    const manyIssues = Array.from({ length: 301 }, (_, index) =>
      issue(index + 1, `Cached issue ${index + 1}`, {
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      }),
    );
    manyIssues[300] = issue(301, "Duplicate beyond lifecycle cap", {
      labels: ["duplicate"],
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const report = buildPreStartCheck(repo("owner/repo"), manyIssues, [], [], "owner/repo", { issueNumber: 301 });
    expect(report.lifecycle).toBe("duplicate");
    expect(report.recommendation).toBe("avoid");
    expect(report.blockers.some((blocker) => /duplicate in cached metadata/i.test(blocker))).toBe(true);
    assertPublicSafe(report);
  });

  it("raises for a thin issue that needs more proof", () => {
    const r = repo("owner/repo");
    const issues = [issue(6, "Something is broken somewhere", { body: "broken" })];
    const report = buildPreStartCheck(r, issues, [], [], "owner/repo", { issueNumber: 6 });
    expect(report.issueQualityStatus).toBe("needs_proof");
    expect(report.recommendation).toBe("raise");
    assertPublicSafe(report);
  });

  it("raises when the requested issue number is not in cached metadata", () => {
    const r = repo("owner/repo");
    const report = buildPreStartCheck(r, [issue(1, "Real issue")], [], [], "owner/repo", { issueNumber: 999 });
    expect(report.found).toBe(false);
    expect(report.recommendation).toBe("raise");
    expect(report.blockers.some((b) => /#999 was not found/i.test(b))).toBe(true);
    assertPublicSafe(report);
  });

  it("resolves a target by fuzzy title match", () => {
    const r = repo("owner/repo");
    const issues = [issue(7, "Fix flaky retry backoff in queue worker"), issue(8, "Unrelated documentation polish")];
    const report = buildPreStartCheck(r, issues, [], [], "owner/repo", { title: "flaky retry backoff queue worker" });
    expect(report.target.matchedBy).toBe("title");
    expect(report.target.resolvedIssueNumber).toBe(7);
    expect(report.found).toBe(true);
    assertPublicSafe(report);
  });

  it("raises when a supplied title matches no cached issue", () => {
    const r = repo("owner/repo");
    const report = buildPreStartCheck(r, [issue(1, "Fix parser crash")], [], [], "owner/repo", { title: "qqqq wwww eeee rrrr" });
    expect(report.found).toBe(false);
    expect(report.target.matchedBy).toBe("none");
    expect(report.recommendation).toBe("raise");
    assertPublicSafe(report);
  });

  it("raises when the supplied title has no meaningful tokens to match", () => {
    const r = repo("owner/repo");
    const report = buildPreStartCheck(r, [issue(1, "Fix parser crash on empty input handling")], [], [], "owner/repo", { title: "the and for with" });
    expect(report.found).toBe(false);
    expect(report.target.matchedBy).toBe("none");
    expect(report.recommendation).toBe("raise");
    assertPublicSafe(report);
  });

  it("raises on a direct-PR-first repository", () => {
    const r = repo("owner/repo", { issueDiscoveryShare: 0 });
    const report = buildPreStartCheck(r, [issue(1, "Fix parser crash on empty input handling")], [], [], "owner/repo", { issueNumber: 1 });
    expect(report.lane.lane).toBe("direct_pr");
    expect(report.recommendation).toBe("raise");
    expect(report.reasons.some((reason) => /direct-PR first/i.test(reason))).toBe(true);
    assertPublicSafe(report);
  });

  it("flags planned-path overlap with recently merged work", () => {
    const r = repo("owner/repo");
    const merged = [mergedPr(40, "Refactor labels module", { changedFiles: ["src/github/labels.ts"] })];
    const report = buildPreStartCheck(r, [], [], merged, "owner/repo", { plannedPaths: ["src/github/labels.ts"] });
    expect(report.target.matchedBy).toBe("planned_paths");
    expect(report.claimStatus).toBe("claimed");
    expect(report.duplicateClusterRisk).toBe("medium");
    expect(report.recommendation).toBe("raise");
    assertPublicSafe(report);
  });

  it("returns go for planned paths with no overlapping merged work", () => {
    const r = repo("owner/repo");
    const merged = [mergedPr(41, "Unrelated change", { changedFiles: ["src/other/thing.ts"] })];
    const report = buildPreStartCheck(r, [], [], merged, "owner/repo", { plannedPaths: ["src/github/labels.ts"] });
    expect(report.target.matchedBy).toBe("planned_paths");
    expect(report.claimStatus).toBe("unclaimed");
    expect(report.duplicateClusterRisk).toBe("none");
    expect(report.recommendation).toBe("go");
    assertPublicSafe(report);
  });

  it("raises a clean issue when planned paths overlap recently merged work", () => {
    const r = repo("owner/repo");
    const issues = [issue(9, "Improve label caching in the sync worker")];
    const merged = [mergedPr(50, "Tune cache", { changedFiles: ["src/cache.ts"] })];
    const report = buildPreStartCheck(r, issues, [], merged, "owner/repo", { issueNumber: 9, plannedPaths: ["src/cache.ts"] });
    expect(report.target.matchedBy).toBe("issue_number");
    expect(report.claimStatus).toBe("unclaimed");
    expect(report.duplicateClusterRisk).toBe("medium");
    expect(report.recommendation).toBe("raise");
    expect(report.reasons.some((reason) => /possible duplicate/i.test(reason))).toBe(true);
    assertPublicSafe(report);
  });

  it("keeps the highest risk when issue and planned-path signals both apply", () => {
    const r = repo("owner/repo");
    const issues = [issue(3, "Add pagination to the labels endpoint")];
    const prs = [pr(31, "Paginate labels", { linkedIssues: [3] }), pr(32, "Labels pagination", { linkedIssues: [3] })];
    const merged = [mergedPr(33, "Touch labels", { changedFiles: ["src/github/labels.ts"] })];
    const report = buildPreStartCheck(r, issues, prs, merged, "owner/repo", { issueNumber: 3, plannedPaths: ["src/github/labels.ts"] });
    expect(report.duplicateClusterRisk).toBe("high");
    expect(report.recommendation).toBe("avoid");
    assertPublicSafe(report);
  });

  it("raises when no target is supplied at all", () => {
    const r = repo("owner/repo");
    const report = buildPreStartCheck(r, [issue(1, "Real issue")], [], [], "owner/repo", {});
    expect(report.found).toBe(false);
    expect(report.target.matchedBy).toBe("none");
    expect(report.recommendation).toBe("raise");
    expect(report.claimStatus).toBe("unknown");
    assertPublicSafe(report);
  });
});
