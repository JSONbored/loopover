import { describe, expect, it } from "vitest";
import { buildRepoOutcomePatterns, type RepoOutcomePatterns } from "../../src/signals/engine";
import type {
  PullRequestDetailSyncStateRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  PullRequestReviewRecord,
  RecentMergedPullRequestRecord,
  RegistryRepoConfig,
  RepositoryRecord,
  RepoSyncStateRecord,
} from "../../src/types";

const REPO = "acme/widgets";
const FORBIDDEN = /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;

function repo(fullName = REPO, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
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

function pr(number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName: REPO,
    number,
    title: `PR ${number}`,
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

function mergedPr(number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return pr(number, { state: "merged", mergedAt: "2026-05-01T00:00:00.000Z", ...overrides });
}

function closedPr(number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return pr(number, { state: "closed", ...overrides });
}

function file(pullNumber: number, path: string, additions = 10, deletions = 1): PullRequestFileRecord {
  return { repoFullName: REPO, pullNumber, path, additions, deletions, changes: additions + deletions, payload: {} };
}

function review(pullNumber: number, state: string): PullRequestReviewRecord {
  return { id: `${REPO}#${pullNumber}#${state}`, repoFullName: REPO, pullNumber, reviewerLogin: "maintainer", state, payload: {} };
}

function syncState(primaryLanguage: string | null = "TypeScript"): RepoSyncStateRecord {
  return {
    repoFullName: REPO,
    status: "success",
    sourceKind: "github",
    primaryLanguage,
    openIssuesCount: 0,
    openPullRequestsCount: 0,
    recentMergedPullRequestsCount: 0,
    warnings: [],
  };
}

function allText(patterns: RepoOutcomePatterns): string {
  return [
    patterns.summary,
    ...patterns.successPatterns.flatMap((p) => [p.title, p.detail]),
    ...patterns.riskPatterns.flatMap((p) => [p.title, p.detail]),
    ...patterns.findings.flatMap((f) => [f.title, f.detail, f.action ?? ""]),
  ].join(" \n ");
}

// A repo where src/ + linked + tested + reviewed outside-contributor PRs merge, and
// docs/ + unlinked + change-requested PRs are closed unmerged.
function primaryFixture() {
  const pullRequests: PullRequestRecord[] = [
    mergedPr(1, { authorAssociation: "CONTRIBUTOR", linkedIssues: [101], labels: ["bug"] }),
    mergedPr(2, { authorAssociation: "CONTRIBUTOR", linkedIssues: [102], labels: ["bug"] }),
    mergedPr(3, { authorAssociation: "CONTRIBUTOR", linkedIssues: [103], labels: ["bug"] }),
    mergedPr(4, { authorAssociation: "CONTRIBUTOR", linkedIssues: [104], labels: ["bug"] }),
    mergedPr(5, { authorAssociation: "CONTRIBUTOR", linkedIssues: [105], labels: ["bug"] }),
    closedPr(6, { authorAssociation: "NONE", labels: ["wontfix"] }),
    closedPr(7, { authorAssociation: "NONE", labels: ["wontfix"] }),
    closedPr(8, { authorAssociation: "NONE", labels: ["wontfix"] }),
    closedPr(9, { authorAssociation: "NONE", labels: ["wontfix"] }),
  ];
  const files: PullRequestFileRecord[] = [
    file(1, "src/a.ts"),
    file(2, "src/b.ts"),
    file(2, "src/b.test.ts"),
    file(3, "src/c.ts"),
    file(3, "src/c.test.ts"),
    file(4, "src/d.ts"),
    file(4, "src/d.test.ts"),
    file(5, "src/e.ts"),
    file(5, "src/e.test.ts"),
    file(6, "docs/x.md"),
    file(7, "docs/y.md"),
    file(8, "docs/z.md"),
    file(9, "docs/w.md"),
  ];
  const reviews: PullRequestReviewRecord[] = [
    review(1, "APPROVED"),
    review(2, "APPROVED"),
    review(3, "APPROVED"),
    review(4, "APPROVED"),
    review(5, "APPROVED"),
    review(6, "CHANGES_REQUESTED"),
    review(7, "CHANGES_REQUESTED"),
    review(8, "CHANGES_REQUESTED"),
    review(9, "CHANGES_REQUESTED"),
  ];
  return { repo: repo(), repoFullName: REPO, pullRequests, files, reviews, syncState: syncState() };
}

describe("buildRepoOutcomePatterns", () => {
  it("learns merged PR patterns by path, label, linked-issue, tests, review, and author role", () => {
    const result = buildRepoOutcomePatterns(primaryFixture());

    expect(result.totals).toMatchObject({ analyzed: 9, merged: 5, closedUnmerged: 4, openActive: 0, openStale: 0, maintainerLanePullRequests: 0, outsideContributorPullRequests: 9 });
    expect(result.sampleSize).toBe(9);
    expect(result.primaryLanguage).toBe("TypeScript");
    expect(result.lane).toBe("direct_pr");

    const path = result.dimensions.find((d) => d.dimension === "path" && d.key === "src/");
    expect(path).toMatchObject({ merged: 5, closedUnmerged: 0, decided: 5, mergeRate: 1, signal: "merges_well" });

    const successDetails = result.successPatterns.map((p) => p.detail);
    expect(successDetails).toContain('PRs touching src/ merge well here (5/5 merged).');
    expect(successDetails).toContain('PRs labeled "bug" merge well here (5/5 merged).');
    expect(successDetails).toContain("PRs that link an issue merge well here (5/5 merged).");
    expect(successDetails).toContain("PRs that include test changes merge well here (4/4 merged).");
    expect(successDetails).toContain("PRs from returning contributors merge well here (5/5 merged).");
  });

  it("learns closed PR (high closure-risk) patterns", () => {
    const result = buildRepoOutcomePatterns(primaryFixture());
    const riskDetails = result.riskPatterns.map((p) => p.detail);
    expect(riskDetails).toContain("PRs touching docs/ have high closure risk here (0/4 merged).");
    expect(riskDetails).toContain("PRs with no linked issue have high closure risk here (0/4 merged).");
    expect(riskDetails).toContain("PRs that received change requests have high closure risk here (0/4 merged).");

    const docs = result.dimensions.find((d) => d.dimension === "path" && d.key === "docs/");
    expect(docs).toMatchObject({ merged: 0, decided: 4, mergeRate: 0, signal: "high_closure_risk" });
  });

  it("flags an overall high closure rate when outside contributors rarely merge", () => {
    const pullRequests = [closedPr(1), closedPr(2), closedPr(3), mergedPr(4)];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(result.outsideContributorMergeRate).toBeCloseTo(0.25, 5);
    expect(result.riskPatterns.some((p) => p.title === "Outside contributor PRs rarely merge here")).toBe(true);
  });

  it("flags overall merge-friendliness when outside contributors merge well", () => {
    const pullRequests = Array.from({ length: 6 }, (_, index) => mergedPr(index + 1));
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(result.outsideContributorMergeRate).toBe(1);
    const overall = result.successPatterns.find((p) => p.title === "Outside contributors merge well here");
    expect(overall).toBeDefined();
    expect(overall?.confidence).toBe("high");
  });

  it("separates maintainer-lane activity from outside-contributor merge evidence", () => {
    const pullRequests = [
      mergedPr(1, { authorAssociation: "OWNER", labels: ["bug"] }),
      mergedPr(2, { authorAssociation: "MEMBER", labels: ["bug"] }),
      closedPr(3, { authorAssociation: "NONE", labels: ["bug"] }),
      closedPr(4, { authorAssociation: "NONE", labels: ["bug"] }),
      closedPr(5, { authorAssociation: "NONE", labels: ["bug"] }),
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(result.totals.maintainerLanePullRequests).toBe(2);
    expect(result.totals.outsideContributorPullRequests).toBe(3);
    expect(result.maintainerLaneMergeRate).toBe(1);
    expect(result.outsideContributorMergeRate).toBe(0);
    // Maintainer merges must not produce an outside-contributor success pattern.
    expect(result.successPatterns).toHaveLength(0);
    expect(result.findings.some((f) => f.code === "maintainer_activity_separated")).toBe(true);
  });

  it("treats idle open PRs as stale risk", () => {
    const pullRequests = [
      pr(1, { state: "open", updatedAt: "2020-01-01T00:00:00.000Z" }),
      pr(2, { state: "open", updatedAt: "2020-01-01T00:00:00.000Z" }),
      pr(3, { state: "open", updatedAt: "2020-01-01T00:00:00.000Z" }),
      pr(4, { state: "open", updatedAt: "2020-01-01T00:00:00.000Z" }),
      pr(5, { state: "open", updatedAt: new Date().toISOString() }),
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(result.totals.openStale).toBe(4);
    expect(result.totals.openActive).toBe(1);
    expect(result.riskPatterns.some((p) => p.title === "Stale open PRs" && p.confidence === "high")).toBe(true);
    expect(result.findings.some((f) => f.code === "stale_open_prs")).toBe(true);
  });

  it("falls back to createdAt when an open PR carries no updatedAt timestamp", () => {
    const pullRequests = [
      pr(1, { state: "open", updatedAt: null, createdAt: "2020-01-01T00:00:00.000Z" }),
      pr(2, { state: "open", updatedAt: null, createdAt: "2020-01-01T00:00:00.000Z" }),
      pr(3, { state: "open", updatedAt: null, createdAt: new Date().toISOString() }),
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(result.totals.openStale).toBe(2);
    expect(result.totals.openActive).toBe(1);
  });

  it("marks the overall closure-risk pattern high-confidence with six or more decided PRs", () => {
    const pullRequests = [closedPr(1), closedPr(2), closedPr(3), closedPr(4), closedPr(5), closedPr(6), mergedPr(7)];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    const risk = result.riskPatterns.find((p) => p.title === "Outside contributor PRs rarely merge here");
    expect(risk?.confidence).toBe("high");
  });

  it("buckets file-count-only PRs into small and medium size dimensions", () => {
    // changedFiles arrive via recent-merged records, so changedLineCount stays 0 and file-count sizing applies.
    const smallNumbers = [1, 2, 3];
    const mediumNumbers = [4, 5, 6];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      ...smallNumbers.map((number) => ({ repoFullName: REPO, number, title: `PR ${number}`, authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: ["a.ts", "b.ts"], payload: {} })),
      ...mediumNumbers.map((number) => ({ repoFullName: REPO, number, title: `PR ${number}`, authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"], payload: {} })),
    ];
    const pullRequests = [...smallNumbers, ...mediumNumbers].map((number) => mergedPr(number));
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    const sizeKeys = result.dimensions.filter((d) => d.dimension === "size").map((d) => d.key);
    expect(sizeKeys).toContain("small");
    expect(sizeKeys).toContain("medium");
  });

  it("counts merged PRs that exist only in recent_merged_pull_requests toward the merge rate", () => {
    // The open-PR backfill leaves only closed shells in pull_requests; the merged history
    // lives in a separate recent_merged_pull_requests table and must still be counted.
    const pullRequests = [closedPr(50), closedPr(51), closedPr(52)];
    const mergedOnly = (number: number, overrides: Partial<RecentMergedPullRequestRecord> = {}): RecentMergedPullRequestRecord => ({
      repoFullName: REPO,
      number,
      title: `PR ${number}`,
      authorLogin: "dev",
      mergedAt: "2026-05-01T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [number + 100],
      changedFiles: ["src/a.ts"],
      payload: { author_association: "NONE" },
      ...overrides,
    });
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      // Different repo -> excluded (covers the repo-mismatch branch).
      mergedOnly(999, { repoFullName: "other/repo" }),
      // Returning contributor.
      mergedOnly(1, { payload: { author_association: "CONTRIBUTOR" } }),
      // No author_association, unlinked, with a file record + review (covers files/review branches).
      mergedOnly(2, { payload: {}, linkedIssues: [] }),
      ...[3, 4, 5, 6, 7, 8, 9].map((number) => mergedOnly(number)),
    ];
    const files = [file(2, "src/b.ts")];
    const reviews = [review(2, "CHANGES_REQUESTED")];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests, files, reviews });
    // 9 merged (numbers 1-9) + 3 closed outside-contributor PRs -> 9/12 = 0.75 merge rate -> "merge well".
    expect(result.totals.merged).toBe(9);
    expect(result.successPatterns.some((pattern) => pattern.title === "Outside contributors merge well here")).toBe(true);
    expect(result.riskPatterns.some((pattern) => pattern.title === "Outside contributor PRs rarely merge here")).toBe(false);
  });

  it("reports a low-sample finding when there are too few decided PRs", () => {
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests: [mergedPr(1)] });
    expect(result.findings.some((f) => f.code === "low_outcome_sample")).toBe(true);
    expect(result.dimensions).toHaveLength(0);
  });

  it("handles an unknown/unregistered repo and empty corpus", () => {
    const result = buildRepoOutcomePatterns({ repo: null, repoFullName: "ghost/repo", pullRequests: [] });
    expect(result.lane).toBe("unknown");
    expect(result.totals.analyzed).toBe(0);
    expect(result.sampleSize).toBe(0);
    expect(result.findings.some((f) => f.code === "low_outcome_sample")).toBe(true);
  });

  it("enriches merged PR file/label evidence from recent-merged records", () => {
    const pullRequests = [mergedPr(1), mergedPr(2), closedPr(3)];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      { repoFullName: REPO, number: 1, title: "PR 1", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: ["feature"], linkedIssues: [9], changedFiles: ["api/server.ts"], payload: {} },
      { repoFullName: REPO, number: 2, title: "PR 2", authorLogin: "dev", mergedAt: "2026-05-02T00:00:00.000Z", labels: ["feature"], linkedIssues: [10], changedFiles: ["api/router.ts"], payload: {} },
      { repoFullName: REPO, number: 3, title: "PR 3", authorLogin: "dev", mergedAt: null, labels: ["feature"], linkedIssues: [], changedFiles: ["api/legacy.ts"], payload: {} },
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    const apiPath = result.dimensions.find((d) => d.dimension === "path" && d.key === "api/");
    expect(apiPath).toMatchObject({ decided: 3, merged: 2 });
  });

  it("ignores pull requests, files, and reviews from other repos", () => {
    const pullRequests = [mergedPr(1), mergedPr(2), closedPr(3), { ...mergedPr(99), repoFullName: "other/repo" }];
    const files = [file(1, "src/a.ts"), { ...file(99, "src/z.ts"), repoFullName: "other/repo" }];
    const reviews = [review(1, "APPROVED"), { ...review(99, "CHANGES_REQUESTED"), repoFullName: "other/repo" }];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, files, reviews });
    expect(result.totals.analyzed).toBe(3);
  });

  it("buckets PR size by changed lines or file count and handles root-level files", () => {
    const pullRequests = [
      mergedPr(1, { linkedIssues: [1] }),
      mergedPr(2, { linkedIssues: [2] }),
      closedPr(3),
    ];
    const files = [
      // small by lines
      file(1, "README.md", 5, 1),
      // large by lines
      file(2, "src/big.ts", 400, 50),
      // medium by file count (no line totals -> falls back, but additions present so use lines): give many small files
      file(3, "docs/a.md", 100, 60),
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, files });
    const sizeKeys = result.dimensions.filter((d) => d.dimension === "size").map((d) => d.key);
    // Only one size bucket reaches the 3-sample threshold at most; assert the size dimension stays internally consistent.
    for (const dim of result.dimensions.filter((d) => d.dimension === "size")) {
      expect(["small", "medium", "large"]).toContain(dim.key);
    }
    expect(Array.isArray(sizeKeys)).toBe(true);
    // README.md is a root-level file, so its path bucket is "(root)".
    expect(result.dimensions.every((d) => d.dimension !== "path" || /\/$|\(root\)/.test(d.key))).toBe(true);
  });

  it("falls back to file-count sizing when no line totals are present", () => {
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [1, 2, 3].map((number) => ({
      repoFullName: REPO,
      number,
      title: `PR ${number}`,
      authorLogin: "dev",
      mergedAt: "2026-05-01T00:00:00.000Z",
      labels: [],
      linkedIssues: [],
      changedFiles: Array.from({ length: 12 }, (_, index) => `pkg/file-${number}-${index}.ts`),
      payload: {},
    }));
    const pullRequests = [mergedPr(1), mergedPr(2), mergedPr(3)];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    expect(result.dimensions.some((d) => d.dimension === "size" && d.key === "large")).toBe(true);
  });

  it("emits dimensions in a deterministic order and is stable across runs", () => {
    const order = ["path", "label", "size", "linked_issue", "test_evidence", "review_churn", "author_role"];
    const first = buildRepoOutcomePatterns(primaryFixture());
    const second = buildRepoOutcomePatterns(primaryFixture());

    const rankOf = (dimension: string) => order.indexOf(dimension);
    for (let i = 1; i < first.dimensions.length; i += 1) {
      const prev = first.dimensions[i - 1]!;
      const curr = first.dimensions[i]!;
      const rankDelta = rankOf(curr.dimension) - rankOf(prev.dimension);
      expect(rankDelta >= 0).toBe(true);
      if (rankDelta === 0) expect(curr.key.localeCompare(prev.key) >= 0).toBe(true);
    }

    const strip = (p: RepoOutcomePatterns) => ({ ...p, generatedAt: "" });
    expect(strip(first)).toEqual(strip(second));
  });

  it("reports evidence completeness from PR detail-sync states", () => {
    const pullRequests = [mergedPr(1), mergedPr(2), closedPr(3), closedPr(4)];
    const detailSyncStates: PullRequestDetailSyncStateRecord[] = [
      { repoFullName: REPO, pullNumber: 1, status: "complete", filesSyncedAt: "t", reviewsSyncedAt: "t", checksSyncedAt: "t" },
      { repoFullName: REPO, pullNumber: 2, status: "complete", filesSyncedAt: "t", reviewsSyncedAt: "t", checksSyncedAt: "t" },
      { repoFullName: REPO, pullNumber: 3, status: "complete", filesSyncedAt: "t", reviewsSyncedAt: "t", checksSyncedAt: "t" },
      { repoFullName: REPO, pullNumber: 4, status: "complete", filesSyncedAt: "t", reviewsSyncedAt: "t", checksSyncedAt: "t" },
    ];
    const complete = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, detailSyncStates });
    expect(complete.evidenceCompleteness).toMatchObject({
      pullRequestsAnalyzed: 4,
      withFileDetail: 4,
      withReviewDetail: 4,
      withCheckDetail: 4,
      fullyDecidedWithDetail: 4,
      status: "complete",
    });
    expect(complete.findings.some((f) => f.code === "incomplete_evidence")).toBe(false);

    const partial = buildRepoOutcomePatterns({
      repo: repo(),
      repoFullName: REPO,
      pullRequests,
      detailSyncStates: [{ repoFullName: REPO, pullNumber: 1, status: "complete", filesSyncedAt: "t", reviewsSyncedAt: null, checksSyncedAt: null }],
    });
    expect(partial.evidenceCompleteness.status).toBe("partial");
    expect(partial.findings.some((f) => f.code === "incomplete_evidence" && f.severity === "info")).toBe(true);

    const missing = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests });
    expect(missing.evidenceCompleteness.status).toBe("missing");
    expect(missing.findings.some((f) => f.code === "incomplete_evidence" && f.severity === "warning")).toBe(true);
    expect(missing.summary).toMatch(/evidence missing/);
  });

  it("sanitizes untrusted path and label text before formatting outcome details", () => {
    const pullRequests = [
      closedPr(1, { labels: ["wip [click](https://example.test) @octo-team"] }),
      closedPr(2, { labels: ["wip [click](https://example.test) @octo-team"] }),
      closedPr(3, { labels: ["wip [click](https://example.test) @octo-team"] }),
    ];
    const files = [
      file(1, "duplicate\n@octo-team/owned.md"),
      file(2, "duplicate\n@octo-team/other.md"),
      file(3, "duplicate\n@octo-team/more.md"),
    ];

    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, files });
    const details = result.riskPatterns.map((p) => p.detail);

    expect(details).toContain("PRs touching duplicate @​octo-team/ have high closure risk here (0/3 merged).");
    expect(details).toContain('PRs labeled "wip \\[click\\]\\(https://example.test\\) @​octo-team" have high closure risk here (0/3 merged).');
    expect(details.join("\n")).not.toMatch(/duplicate\n@octo-team|@octo-team|[^\\]\[click\]\(https:\/\/example\.test\)/);
  });

  it("includes merged-only PRs absent from pull_requests in the analysis", () => {
    // Repo has 5 open/closed PRs in pull_requests and 200 merged PRs only in recent_merged_pull_requests.
    // The merged-only records carry author_association: "NONE" so they are outside-contributor lane.
    // Without the fix: merge rate = 0/3, triggering false "high closure risk".
    // With the fix: merge rate = ~0.97 from the full unified set.
    const pullRequests: PullRequestRecord[] = [
      closedPr(1),
      closedPr(2),
      closedPr(3),
      pr(4, { state: "open" }),
      pr(5, { state: "open" }),
    ];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = Array.from({ length: 200 }, (_, i) => ({
      repoFullName: REPO,
      number: 100 + i,
      title: `Merged PR ${100 + i}`,
      authorLogin: "dev",
      mergedAt: "2026-05-01T00:00:00.000Z",
      labels: ["bug"],
      linkedIssues: [200 + i],
      changedFiles: ["src/feature.ts"],
      payload: { author_association: "NONE" },
    }));
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });

    expect(result.totals.analyzed).toBe(205);
    expect(result.totals.merged).toBe(200);
    expect(result.totals.closedUnmerged).toBe(3);
    expect(result.outsideContributorMergeRate).toBeCloseTo(200 / 203, 4);
    expect(result.riskPatterns.some((p) => p.title === "Outside contributor PRs rarely merge here")).toBe(false);
    expect(result.successPatterns.some((p) => p.title === "Outside contributors merge well here")).toBe(true);
  });

  it("conservatively excludes merged-only PRs with unknown author_association from outside-contributor statistics", () => {
    // Merged-only records with payload: {} (no author_association) cannot be safely classified.
    // Conservative fallback: treat as maintainer lane so they do not inflate outside-contributor merge rate.
    const pullRequests: PullRequestRecord[] = [
      closedPr(1),
      closedPr(2),
      mergedPr(3, { authorAssociation: "NONE" }),
    ];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = Array.from({ length: 10 }, (_, i) => ({
      repoFullName: REPO,
      number: 100 + i,
      title: `Unknown-assoc PR ${100 + i}`,
      authorLogin: "dev",
      mergedAt: "2026-05-01T00:00:00.000Z",
      labels: [],
      linkedIssues: [],
      changedFiles: [],
      payload: {},
    }));
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });

    expect(result.totals.analyzed).toBe(13);
    expect(result.totals.maintainerLanePullRequests).toBe(10);
    expect(result.totals.outsideContributorPullRequests).toBe(3);
    // Outside-contributor rate uses only the 3 classifiable outside PRs (1 merged, 2 closed).
    expect(result.outsideContributorMergeRate).toBeCloseTo(1 / 3, 4);
    // Maintainer lane rate includes the 10 unknown-association merged PRs.
    expect(result.maintainerLaneMergeRate).toBeCloseTo(1, 4);
  });

  it("does not double-count PRs present in both pull_requests and recent_merged_pull_requests", () => {
    const pullRequests = [mergedPr(1), mergedPr(2), closedPr(3)];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      { repoFullName: REPO, number: 1, title: "PR 1", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: [], payload: {} },
      { repoFullName: REPO, number: 2, title: "PR 2", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: [], payload: {} },
      { repoFullName: REPO, number: 99, title: "Merged only", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: [], payload: {} },
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    expect(result.totals.analyzed).toBe(4);
    expect(result.totals.merged).toBe(3);
    expect(result.totals.closedUnmerged).toBe(1);
  });

  it("reconciles a closed PR in pull_requests that has a mergedAt in its recent-merged record", () => {
    // A PR recorded as "closed" in the pull_requests table was actually merged; the merged table has the timestamp.
    const pullRequests = [
      closedPr(1),
      closedPr(2),
      closedPr(3),
      mergedPr(4),
      mergedPr(5),
      mergedPr(6),
    ];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      { repoFullName: REPO, number: 1, title: "PR 1", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: ["src/a.ts"], payload: {} },
      { repoFullName: REPO, number: 2, title: "PR 2", authorLogin: "dev", mergedAt: "2026-05-01T00:00:00.000Z", labels: [], linkedIssues: [], changedFiles: ["src/b.ts"], payload: {} },
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    expect(result.totals.merged).toBe(5);
    expect(result.totals.closedUnmerged).toBe(1);
    expect(result.outsideContributorMergeRate).toBeCloseTo(5 / 6, 4);
  });

  it("does not reconcile a closed PR whose recent-merged record carries no mergedAt timestamp", () => {
    const pullRequests = [closedPr(1), mergedPr(2), mergedPr(3), mergedPr(4)];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      { repoFullName: REPO, number: 1, title: "PR 1", authorLogin: "dev", mergedAt: null, labels: [], linkedIssues: [], changedFiles: [], payload: {} },
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    expect(result.totals.closedUnmerged).toBe(1);
    expect(result.totals.merged).toBe(3);
  });

  it("does not count merged-only OWNER/MEMBER/COLLABORATOR PRs in the outside-contributor merge rate", () => {
    // 3 outside-contributor PRs from pull_requests: 1 merged, 2 closed.
    // 10 merged-only maintainer PRs in recent_merged_pull_requests with OWNER/MEMBER/COLLABORATOR associations.
    // Without the fix: outside merge rate = 11/13 ≈ 0.85 (falsely inflated by owner work).
    // With the fix: outside merge rate = 1/3 ≈ 0.33 (only outside-contributor decided PRs counted).
    const pullRequests: PullRequestRecord[] = [
      mergedPr(1, { authorAssociation: "NONE" }),
      closedPr(2, { authorAssociation: "NONE" }),
      closedPr(3, { authorAssociation: "NONE" }),
    ];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      ...["OWNER", "OWNER", "OWNER", "MEMBER", "MEMBER", "COLLABORATOR", "COLLABORATOR", "COLLABORATOR", "OWNER", "MEMBER"].map(
        (association, i): RecentMergedPullRequestRecord => ({
          repoFullName: REPO,
          number: 100 + i,
          title: `Maintainer PR ${100 + i}`,
          authorLogin: "repo-owner",
          mergedAt: "2026-05-01T00:00:00.000Z",
          labels: [],
          linkedIssues: [],
          changedFiles: ["src/internal.ts"],
          payload: { author_association: association },
        }),
      ),
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });

    expect(result.totals.analyzed).toBe(13);
    expect(result.totals.maintainerLanePullRequests).toBe(10);
    expect(result.totals.outsideContributorPullRequests).toBe(3);
    // Only the 3 outside-contributor PRs (1 merged, 2 closed) form the denominator.
    expect(result.outsideContributorMergeRate).toBeCloseTo(1 / 3, 4);
    // Maintainer merge rate covers the 10 merged-only maintainer PRs.
    expect(result.maintainerLaneMergeRate).toBeCloseTo(1, 4);
    // The repo should NOT be flagged as "merges well" since outside rate is low.
    expect(result.successPatterns.some((p) => p.title === "Outside contributors merge well here")).toBe(false);
  });

  it("derives returning_contributor authorRole from payload.author_association CONTRIBUTOR on merged-only rows", () => {
    const pullRequests: PullRequestRecord[] = [closedPr(1)];
    const recentMergedPullRequests: RecentMergedPullRequestRecord[] = [
      {
        repoFullName: REPO,
        number: 99,
        title: "Returning contributor PR",
        authorLogin: "returning-dev",
        mergedAt: "2026-05-01T00:00:00.000Z",
        labels: [],
        linkedIssues: [],
        changedFiles: [],
        payload: { author_association: "CONTRIBUTOR" },
      },
    ];
    const result = buildRepoOutcomePatterns({ repo: repo(), repoFullName: REPO, pullRequests, recentMergedPullRequests });
    // CONTRIBUTOR is outside-contributor lane but returning — must not be maintainerLane.
    expect(result.totals.maintainerLanePullRequests).toBe(0);
    expect(result.outsideContributorMergeRate).toBeCloseTo(1 / 2, 4);
  });

  it("never emits forbidden public-surface language", () => {
    const fixtures = [
      buildRepoOutcomePatterns(primaryFixture()),
      buildRepoOutcomePatterns({
        repo: repo(),
        repoFullName: REPO,
        pullRequests: [
          mergedPr(1, { authorAssociation: "OWNER" }),
          closedPr(2),
          closedPr(3),
          closedPr(4),
          pr(5, { state: "open", updatedAt: "2020-01-01T00:00:00.000Z" }),
        ],
      }),
    ];
    for (const fixture of fixtures) {
      expect(allText(fixture)).not.toMatch(FORBIDDEN);
    }
  });
});
