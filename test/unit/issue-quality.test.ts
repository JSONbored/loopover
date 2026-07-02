import { describe, expect, it } from "vitest";
import {
  buildContributorFit,
  buildContributorOpportunities,
  buildIssueDiscoveryLifecycleReport,
  buildIssueQualityReport,
  type CollisionReport,
  type ContributorProfile,
  type IssueQualityReport,
} from "../../src/signals/engine";
import type { BountyRecord, IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

describe("issue quality reports", () => {
  it("downgrades issue filing in direct-PR-only repos to needs_proof", () => {
    const repo = directPrRepo("owner/direct");
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 1, "Concrete fix needed", { body: "x".repeat(220), labels: ["bug"], updatedAt: now() })], [], repo.fullName);
    expect(report.issues[0]).toMatchObject({
      status: "needs_proof",
      warnings: expect.arrayContaining([expect.stringMatching(/direct-PR first/i)]),
    });
    expect(report.lane.lane).toBe("direct_pr");
  });

  it("flags issue-discovery repo issues as ready without lane warnings", () => {
    const repo = issueDiscoveryRepo("owner/discovery");
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 2, "Actionable discovery", { body: "x".repeat(220), labels: ["good first issue"], updatedAt: now() })], [], repo.fullName);
    expect(report.lane.lane).toBe("issue_discovery");
    expect(report.issues[0]).toMatchObject({
      status: "ready",
      reasons: expect.arrayContaining([
        "Issue has enough body detail to evaluate.",
        "No active PR is linked in cached metadata.",
      ]),
    });
    expect(report.issues[0]?.score).toBeGreaterThanOrEqual(70);
    expect(report.issues[0]?.warnings).not.toEqual(expect.arrayContaining([expect.stringMatching(/direct-PR/i)]));
  });

  it("marks a thin (vague) issue body as needs_proof", () => {
    const repo = directPrRepo("owner/vague");
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 3, "Fix bug", { body: "Short.", updatedAt: now() })], [], repo.fullName);
    expect(report.issues[0]).toMatchObject({
      status: "needs_proof",
      warnings: expect.arrayContaining([expect.stringMatching(/thin/i)]),
    });
  });

  it("warns when an issue is stale in cached metadata", () => {
    const repo = issueDiscoveryRepo("owner/stale");
    const report = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 4, "Old report", { body: "x".repeat(220), updatedAt: "2025-01-01T00:00:00.000Z" })],
      [],
      repo.fullName,
    );
    expect(report.issues[0]).toMatchObject({
      status: "needs_proof",
      warnings: expect.arrayContaining(["Issue is stale in cached metadata."]),
    });
  });

  it("threads reconciled bounty source and linked-PR state into issue quality", () => {
    const repo = issueDiscoveryRepo("owner/bounty-context");
    const staleBounty: BountyRecord = {
      id: "stale-source",
      repoFullName: repo.fullName,
      issueNumber: 1,
      status: "Active",
      payload: { bounty_alpha: "2.0000" },
      sourceUrl: "https://example.test/bounties/1",
      discoveredAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const staleReport = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 1, "Stale bounty with linked work", { body: "x".repeat(220), linkedPrs: [5] })],
      [pr(repo.fullName, 5, "Work in progress", { linkedIssues: [1] })],
      repo.fullName,
      [staleBounty],
      undefined,
      [recentMergedPr(repo.fullName, 6, "Recently merged fix", { linkedIssues: [1] })],
    );
    const staleEntry = staleReport.issues[0]!;
    expect(staleEntry).toMatchObject({
      status: "do_not_use",
      bounty: {
        id: "stale-source",
        lifecycle: "stale",
        isActiveOpportunity: false,
        fundingStatus: "funded",
        source: {
          sourceUrl: "https://example.test/bounties/1",
          freshness: "stale",
          observedAt: "2025-01-01T00:00:00.000Z",
          ageDays: expect.any(Number),
        },
        linkedPrs: [
          { number: 5, state: "open", isActive: true },
          { number: 6, state: "merged", isActive: false },
        ],
      },
    });
    expect(staleEntry.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/Bounty context .* stale/i)]));
    expect(JSON.stringify(staleEntry.bounty)).not.toMatch(/wallet|hotkey|raw trust|payout|reward estimate|farming|public score/i);

    const activeReport = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 2, "Active bounty", { body: "x".repeat(220) })],
      [],
      repo.fullName,
      [
        {
          id: "active-source",
          repoFullName: repo.fullName,
          issueNumber: 2,
          status: "Open",
          payload: { bounty_alpha: "1.0000" },
          updatedAt: now(),
        },
      ],
    );
    expect(activeReport.issues[0]).toMatchObject({
      status: "ready",
      bounty: { id: "active-source", lifecycle: "active", isActiveOpportunity: true, source: { freshness: "fresh" } },
      reasons: expect.arrayContaining([expect.stringMatching(/Active bounty context/i)]),
    });

    const completedReport = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 3, "Completed bounty", { body: "x".repeat(220) })],
      [],
      repo.fullName,
      [{ id: "completed-source", repoFullName: repo.fullName, issueNumber: 3, status: "Completed", payload: {} }],
    );
    expect(completedReport.issues[0]).toMatchObject({
      status: "do_not_use",
      bounty: { id: "completed-source", lifecycle: "completed", isActiveOpportunity: false },
    });
  });

  it("marks an already-solved issue as do_not_use when a linked PR exists", () => {
    const repo = directPrRepo("owner/solved");
    const linkedPr = pr(repo.fullName, 100, "Fix for #5", { linkedIssues: [5] });
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 5, "Already worked on", { body: "x".repeat(220) })], [linkedPr], repo.fullName);
    expect(report.issues[0]?.status).toBe("do_not_use");
    expect(report.issues[0]?.linkage).toMatchObject({ status: "plausible", source: "github_cache", solvedByPullRequests: [] });
    expect(report.issues[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/already reference this issue/i)]));
  });

  // #perf: the per-issue PR scan is now a prebuilt Map<issueNumber, PR[]> index. These guard the index against
  // (a) two PRs sharing one issue bucket and (b) a metadata back-reference that is already a forward link.
  it("counts multiple PRs linking the same issue without double-counting a symmetric back-reference", () => {
    const repo = directPrRepo("owner/multi-linked");
    const report = buildIssueQualityReport(
      repo,
      // Issue back-references PR 30; PR 30 forward-links the issue (symmetric); PR 31 also links the issue.
      [issue(repo.fullName, 20, "Two PRs already in flight", { body: "x".repeat(220), linkedPrs: [30] })],
      [pr(repo.fullName, 30, "First attempt", { linkedIssues: [20] }), pr(repo.fullName, 31, "Second attempt", { linkedIssues: [20] })],
      repo.fullName,
    );
    expect(report.issues[0]?.status).toBe("do_not_use");
    expect(report.issues[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/2 active PR\(s\) already reference this issue/i)]));
  });

  it("merges multiple high/medium collision clusters that reference the same issue (prebuilt collisions)", () => {
    const repo = issueDiscoveryRepo("owner/two-clusters");
    const collisions: CollisionReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      summary: { clusterCount: 2, highRiskCount: 1, itemsReviewed: 3 },
      clusters: [
        { id: "c1", risk: "high", reason: "duplicate", items: [{ type: "issue", number: 40, title: "dup" }, { type: "pull_request", number: 50, title: "pr" }] },
        { id: "c2", risk: "medium", reason: "overlap", items: [{ type: "issue", number: 40, title: "dup" }, { type: "issue", number: 41, title: "other" }] },
      ],
    };
    const report = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 40, "Referenced by two clusters", { body: "x".repeat(220) })],
      [],
      repo.fullName,
      [],
      collisions,
    );
    // A high-risk cluster on the issue → do_not_use, and the overlap warning fires once.
    expect(report.issues[0]?.status).toBe("do_not_use");
    expect(report.issues[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/duplicate or overlapping issue\/PR context/i)]));
  });

  it("marks issues as do_not_use when cached issue or merged PR metadata already links work", () => {
    const repo = issueDiscoveryRepo("owner/solved-later");
    const report = buildIssueQualityReport(
      repo,
      [
        issue(repo.fullName, 5, "Issue body links a PR", { body: "x".repeat(220), linkedPrs: [100] }),
        issue(repo.fullName, 6, "Recently merged work", { body: "x".repeat(220) }),
      ],
      [],
      repo.fullName,
      [],
      undefined,
      [recentMergedPr(repo.fullName, 101, "Fixes #6", { linkedIssues: [6] })],
    );
    expect(report.issues.find((entry) => entry.number === 5)).toMatchObject({
      status: "do_not_use",
      warnings: expect.arrayContaining([expect.stringMatching(/already references PR/i)]),
    });
    expect(report.issues.find((entry) => entry.number === 6)).toMatchObject({
      status: "do_not_use",
      linkage: { status: "validated", solvedByPullRequests: [101] },
      warnings: expect.arrayContaining([expect.stringMatching(/merged PR/i)]),
    });
  });

  it("does not treat issue-body PR mentions as solved lifecycle evidence", () => {
    const repo = issueDiscoveryRepo("owner/untrusted-issue-pr-mention");
    const poisoned = issue(repo.fullName, 7, "Unsolved report mentions unrelated PR", {
      body: "Detailed report with reproduction steps, but it only says PR #123 looks related.",
      linkedPrs: [123],
    });
    const unrelatedMergedPr = recentMergedPr(repo.fullName, 123, "Unrelated merged work", { linkedIssues: [] });

    const lifecycle = buildIssueDiscoveryLifecycleReport(repo, [poisoned], [], repo.fullName, [unrelatedMergedPr]);
    expect(lifecycle.states[0]).toMatchObject({ number: 7, state: "open", solvedByPullRequests: [] });

    const quality = buildIssueQualityReport(repo, [poisoned], [], repo.fullName, [], undefined, [unrelatedMergedPr]);
    expect(quality.issues[0]).toMatchObject({
      lifecycle: "open",
      linkage: { status: "plausible", solvedByPullRequests: [] },
    });
  });

  it("records raw, validated, and closed-not-solved linkage states separately", () => {
    const repo = issueDiscoveryRepo("owner/linkage");
    const raw = issue(repo.fullName, 1, "Raw issue", { body: "x".repeat(220) });
    const solved = issue(repo.fullName, 2, "Solved issue", { body: "x".repeat(220) });
    const duplicate = issue(repo.fullName, 4, "Duplicate issue", { body: "x".repeat(220), labels: ["duplicate"] });
    const closed = issue(repo.fullName, 3, "Closed issue", { body: "x".repeat(220), state: "closed" });
    const quality = buildIssueQualityReport(repo, [raw, solved, closed, duplicate], [], repo.fullName, [], undefined, [recentMergedPr(repo.fullName, 202, "Fixes #2", { linkedIssues: [2] })]);
    const lifecycle = buildIssueDiscoveryLifecycleReport(repo, [closed], [], repo.fullName);

    expect(quality.issues.find((entry) => entry.number === 1)?.linkage).toMatchObject({ status: "raw", source: "github_cache", solvedByPullRequests: [] });
    expect(quality.issues.find((entry) => entry.number === 2)?.linkage).toMatchObject({ status: "validated", source: "github_cache", solvedByPullRequests: [202] });
    expect(quality.issues.find((entry) => entry.number === 4)?.linkage).toMatchObject({ status: "invalid", source: "github_cache", solvedByPullRequests: [] });
    expect(lifecycle.states[0]).toMatchObject({ number: 3, state: "closed_not_solved", solvedByPullRequests: [] });
  });

  it("surfaces duplicate-prone context via collision detection on both issues", () => {
    const repo = issueDiscoveryRepo("owner/dupes");
    const a = issue(repo.fullName, 10, "Login flow broken when user reconnects after disconnect", { body: "x".repeat(220), labels: ["bug"] });
    const b = issue(repo.fullName, 11, "Login flow fails after reconnect when user disconnects", { body: "x".repeat(220), labels: ["bug"] });
    const report = buildIssueQualityReport(repo, [a, b], [], repo.fullName);
    const flagged = report.issues.filter((entry) => entry.warnings.includes("Potential duplicate or overlapping issue/PR context exists."));
    expect(flagged.map((entry) => entry.number).sort()).toEqual([10, 11]);
  });

  it("downgrades direct-PR-lane issue filing in warnings", () => {
    const repo = directPrRepo("owner/direct-only");
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 20, "Random idea", { body: "Short." })], [], repo.fullName);
    expect(report.issues[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/direct-PR first/i)]));
  });

  it("warns to confirm scope on a maintainer-authored issue but still lets a clean one read ready (#186)", () => {
    const repo = issueDiscoveryRepo("owner/maintainer-open");
    const report = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 30, "Maintainer-created: add reconnect backoff", { body: "x".repeat(220), labels: ["feature"], authorAssociation: "OWNER", updatedAt: now() })],
      [],
      repo.fullName,
    );
    expect(report.issues[0]).toMatchObject({
      status: "ready",
      warnings: expect.arrayContaining(["Maintainer-authored; confirm it is open for outside contribution before starting."]),
    });
  });

  it("never reads a maintainer-authored WIP/internal issue as ready (#186)", () => {
    const repo = issueDiscoveryRepo("owner/maintainer-wip");
    const report = buildIssueQualityReport(
      repo,
      [issue(repo.fullName, 31, "Maintainer-created: internal refactor", { body: "x".repeat(220), labels: ["feature", "internal"], authorAssociation: "OWNER", updatedAt: now() })],
      [],
      repo.fullName,
    );
    expect(report.issues[0]).toMatchObject({
      status: "needs_proof",
      warnings: expect.arrayContaining(["Maintainer-authored and labelled in-progress/internal; not a recommended outside-contributor target without confirmation."]),
    });
  });

  it("respects a worker-budget cap of 100 issues per repo", () => {
    const repo = issueDiscoveryRepo("owner/big");
    const issues = Array.from({ length: 150 }, (_, index) => issue(repo.fullName, index + 1, `bulk ${index}`, { body: "x".repeat(220) }));
    const report = buildIssueQualityReport(repo, issues, [], repo.fullName);
    expect(report.issues.length).toBeLessThanOrEqual(100);
  });

  it("ranks by score before capping to 100, so a strong issue beyond the first 100 in DB order is not dropped (regression)", () => {
    const repo = issueDiscoveryRepo("owner/rank-before-cap");
    // 110 thin, stale filler issues (low score) followed by one detailed, fresh, labelled issue (highest score) —
    // capping by DB-order position before scoring would drop the strong issue entirely.
    const filler = Array.from({ length: 110 }, (_, index) =>
      issue(repo.fullName, index + 1, `bulk ${index}`, { body: "Short.", updatedAt: "2025-01-01T00:00:00.000Z" }),
    );
    const strongIssue = issue(repo.fullName, 111, "Detailed, well-labelled issue", {
      body: "x".repeat(220),
      labels: ["bug"],
      updatedAt: now(),
    });
    const report = buildIssueQualityReport(repo, [...filler, strongIssue], [], repo.fullName);
    expect(report.issues).toHaveLength(100);
    expect(report.issues[0]).toMatchObject({ number: 111, score: 100 });
  });
});

describe("buildContributorOpportunities x issue quality", () => {
  it("drops do_not_use issues from opportunities", () => {
    const repo = issueDiscoveryRepo("owner/dropper");
    const issues = [
      issue(repo.fullName, 1, "Drop me", { body: "x".repeat(220), labels: ["bug"] }),
      issue(repo.fullName, 2, "Keep me", { body: "x".repeat(220), labels: ["bug"] }),
    ];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [
        { number: 1, title: "Drop me", status: "do_not_use", score: 0, reasons: [], warnings: [] },
        { number: 2, title: "Keep me", status: "ready", score: 88, reasons: [], warnings: [] },
      ],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(
      sampleProfile(),
      [repo],
      issues,
      [],
      [],
      new Map([[repo.fullName, quality]]),
    );
    expect(opportunities.map((o) => o.issueNumber)).toEqual([2]);
    expect(opportunities[0]?.reasons).toEqual(expect.arrayContaining(["Issue quality report rates this issue as ready."]));
  });

  it("surfaces the highest-quality issue even when it sits beyond the first 5 in DB order", () => {
    const repo = issueDiscoveryRepo("owner/deep-ready");
    // Six available issues in DB order; the only "ready" one is last (index 5), the rest are "hold".
    const issues = [1, 2, 3, 4, 5, 6].map((n) => issue(repo.fullName, n, `Issue ${n}`, { body: "x".repeat(220), labels: ["bug"] }));
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [
        ...[1, 2, 3, 4, 5].map((n) => ({ number: n, title: `Issue ${n}`, status: "hold" as const, score: 30, reasons: [], warnings: [] })),
        { number: 6, title: "Issue 6", status: "ready" as const, score: 92, reasons: [], warnings: [] },
      ],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(sampleProfile(), [repo], issues, [], [], new Map([[repo.fullName, quality]]));
    // The "ready" issue #6 (highest score) must be surfaced and ranked first, even though it is the
    // 6th available issue -- the per-repo cap selects the best, not the arbitrary first 5.
    expect(opportunities.map((o) => o.issueNumber)).toContain(6);
    expect(opportunities[0]?.issueNumber).toBe(6);
    expect(opportunities[0]?.reasons).toEqual(expect.arrayContaining(["Issue quality report rates this issue as ready."]));
  });

  it("downgrades needs_proof issues to caution and adds a warning", () => {
    const repo = issueDiscoveryRepo("owner/caution");
    const issues = [issue(repo.fullName, 1, "Vague candidate", { body: "x".repeat(220), labels: ["bug"] })];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [{ number: 1, title: "Vague candidate", status: "needs_proof", score: 50, reasons: [], warnings: [] }],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(
      sampleProfile({ reposTouched: [repo.fullName], dominantLabels: ["bug"] }),
      [repo],
      issues,
      [],
      [],
      new Map([[repo.fullName, quality]]),
    );
    expect(opportunities[0]).toMatchObject({ fit: "caution" });
    expect(opportunities[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/needing more proof/i)]));
  });

  it("downgrades a high-score needs_proof issue to caution even when the lane fit is strong", () => {
    const repo = splitLaneRepo("owner/strong-fit");
    const issues = [issue(repo.fullName, 1, "Strong fit but vague", { body: "x".repeat(220), labels: ["bug", "good first issue", "regression"] })];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "split", issueDiscoveryShare: 0.5, directPrShare: 0.5, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [{ number: 1, title: "Strong fit but vague", status: "needs_proof", score: 50, reasons: [], warnings: [] }],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(
      sampleProfile({ reposTouched: [repo.fullName], dominantLabels: ["bug", "good first issue", "regression"] }),
      [repo],
      issues,
      [],
      [],
      new Map([[repo.fullName, quality]]),
    );
    expect(opportunities[0]).toMatchObject({ fit: "caution" });
    expect(opportunities[0]?.score).toBeGreaterThanOrEqual(70);
  });

  it("applies hold-status penalties and warnings", () => {
    const repo = issueDiscoveryRepo("owner/hold");
    const issues = [issue(repo.fullName, 1, "On hold", { body: "x".repeat(220), labels: ["bug"] })];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [{ number: 1, title: "On hold", status: "hold", score: 30, reasons: [], warnings: [] }],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(
      sampleProfile(),
      [repo],
      issues,
      [],
      [],
      new Map([[repo.fullName, quality]]),
    );
    expect(opportunities[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/hold; consider skipping/i)]));
  });

  it("threads the issue-quality map through buildContributorFit so do_not_use is dropped end-to-end", () => {
    const repo = issueDiscoveryRepo("owner/threaded");
    const issues = [
      issue(repo.fullName, 1, "Drop me", { body: "x".repeat(220), labels: ["bug"] }),
      issue(repo.fullName, 2, "Keep me", { body: "x".repeat(220), labels: ["bug"] }),
    ];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [
        { number: 1, title: "Drop me", status: "do_not_use", score: 0, reasons: [], warnings: [] },
        { number: 2, title: "Keep me", status: "ready", score: 88, reasons: [], warnings: [] },
      ],
      summary: "",
    };
    const fit = buildContributorFit(
      sampleProfile(),
      [repo],
      issues,
      [],
      [],
      [],
      [],
      new Map([[repo.fullName, quality]]),
    );
    expect(fit.opportunities.map((o) => o.issueNumber)).toEqual([2]);
  });

  it("matches the repo case-insensitively when looking up cached quality", () => {
    const repo = issueDiscoveryRepo("Owner/MixedCase");
    const issues = [issue(repo.fullName, 1, "Title", { body: "x".repeat(220) })];
    const quality: IssueQualityReport = {
      repoFullName: repo.fullName,
      generatedAt: now(),
      lane: { repoFullName: repo.fullName, lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
      issues: [{ number: 1, title: "Title", status: "do_not_use", score: 0, reasons: [], warnings: [] }],
      summary: "",
    };
    const opportunities = buildContributorOpportunities(
      sampleProfile(),
      [repo],
      issues,
      [],
      [],
      new Map([["owner/mixedcase", quality]]),
    );
    expect(opportunities).toHaveLength(0);
  });
});

function now(): string {
  return new Date().toISOString();
}

function directPrRepo(fullName: string): RepositoryRecord {
  return repoCommon(fullName, { emissionShare: 0.04, issueDiscoveryShare: 0 });
}

function issueDiscoveryRepo(fullName: string): RepositoryRecord {
  return repoCommon(fullName, { emissionShare: 0.02, issueDiscoveryShare: 1 });
}

function splitLaneRepo(fullName: string): RepositoryRecord {
  return repoCommon(fullName, { emissionShare: 0.03, issueDiscoveryShare: 0.5 });
}

function repoCommon(fullName: string, config: Partial<RegistryRepoConfig>): RepositoryRecord {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    isInstalled: false,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare: config.emissionShare ?? 0,
      issueDiscoveryShare: config.issueDiscoveryShare ?? 0,
      maintainerCut: 0,
      labelMultipliers: { bug: 1.1 },
      raw: {},
    },
  } as RepositoryRecord;
}

function issue(repoFullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "Issue body detailed enough to evaluate properly with reproduction steps.",
    updatedAt: now(),
    ...overrides,
  } as IssueRecord;
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
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
    updatedAt: now(),
    ...overrides,
  } as PullRequestRecord;
}

function recentMergedPr(repoFullName: string, number: number, title: string, overrides: Partial<RecentMergedPullRequestRecord> = {}): RecentMergedPullRequestRecord {
  return {
    repoFullName,
    number,
    title,
    authorLogin: "dev",
    htmlUrl: `https://github.com/${repoFullName}/pull/${number}`,
    mergedAt: now(),
    labels: [],
    linkedIssues: [],
    changedFiles: [],
    payload: {},
    ...overrides,
  };
}

function sampleProfile(overrides: Partial<ContributorProfile["registeredRepoActivity"]> = {}): ContributorProfile {
  return {
    login: "tester",
    generatedAt: now(),
    github: { login: "tester", topLanguages: ["TypeScript"], source: "github" } as ContributorProfile["github"],
    source: "github_cache",
    gittensor: null,
    registeredRepoActivity: {
      pullRequests: 0,
      mergedPullRequests: 0,
      issues: 0,
      reposTouched: [],
      dominantLabels: [],
      ...overrides,
    },
    trustSignals: { evidenceScore: 0, level: "new", unlinkedOpenPullRequests: 0, maintainerAssociatedPullRequests: 0 },
  } as unknown as ContributorProfile;
}
