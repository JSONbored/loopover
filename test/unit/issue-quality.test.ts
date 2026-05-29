import { describe, expect, it } from "vitest";
import {
  buildContributorFit,
  buildContributorOpportunities,
  buildIssueQualityReport,
  type ContributorProfile,
  type IssueQualityReport,
} from "../../src/signals/engine";
import type { IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RegistryRepoConfig, RepositoryRecord } from "../../src/types";

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

  it("marks an already-solved issue as do_not_use when a linked PR exists", () => {
    const repo = directPrRepo("owner/solved");
    const linkedPr = pr(repo.fullName, 100, "Fix for #5", { linkedIssues: [5] });
    const report = buildIssueQualityReport(repo, [issue(repo.fullName, 5, "Already worked on", { body: "x".repeat(220) })], [linkedPr], repo.fullName);
    expect(report.issues[0]?.status).toBe("do_not_use");
    expect(report.issues[0]?.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/already reference this issue/i)]));
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
      undefined,
      [recentMergedPr(repo.fullName, 101, "Fixes #6", { linkedIssues: [6] })],
    );
    expect(report.issues.find((entry) => entry.number === 5)).toMatchObject({
      status: "do_not_use",
      warnings: expect.arrayContaining([expect.stringMatching(/already references PR/i)]),
    });
    expect(report.issues.find((entry) => entry.number === 6)).toMatchObject({
      status: "do_not_use",
      warnings: expect.arrayContaining([expect.stringMatching(/merged PR/i)]),
    });
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

  it("respects a worker-budget cap of 100 issues per repo", () => {
    const repo = issueDiscoveryRepo("owner/big");
    const issues = Array.from({ length: 150 }, (_, index) => issue(repo.fullName, index + 1, `bulk ${index}`, { body: "x".repeat(220) }));
    const report = buildIssueQualityReport(repo, issues, [], repo.fullName);
    expect(report.issues.length).toBeLessThanOrEqual(100);
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
      new Map([[repo.fullName, quality]]),
    );
    expect(opportunities.map((o) => o.issueNumber)).toEqual([2]);
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
