import { describe, expect, it } from "vitest";
import {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "../../packages/loopover-engine/src/opportunity-freshness";
import {
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
} from "../../src/signals/engine";
import { buildRepoRewardRisk, rewardRiskFreshnessInternals } from "../../src/signals/reward-risk";
import type { IssueRecord, PullRequestRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

function scoringSnapshot(): ScoringModelSnapshotRecord {
  return {
    id: "freshness-scoring",
    sourceKind: "test",
    sourceUrl: "fixture://freshness",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings: [],
    payload: {},
  };
}

function repo(fullName: string): RepositoryRecord {
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
    },
  };
}

function issue(fullName: string, number: number, title: string, overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName: fullName,
    number,
    title,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "Issue body",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function toFreshnessIssues(issues: IssueRecord[]): FreshnessIssue[] {
  return issues.map((item) => ({
    state: item.state,
    updatedAt: item.updatedAt ?? null,
    createdAt: item.createdAt ?? null,
  }));
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
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("reward-risk freshness parity with loopover-engine", () => {
  const collab = repo("owner/collab-repo");
  const profile = buildContributorProfile("dev", { login: "dev", topLanguages: [], source: "github" }, [], []);
  const history = buildContributorOutcomeHistory({
    login: "dev",
    profile,
    repositories: [collab],
    pullRequests: [],
    issues: [],
    repoStats: [],
  });
  const base = {
    login: "dev" as const,
    repo: collab,
    repoFullName: collab.fullName,
    profile,
    outcomeHistory: history,
    scoringSnapshot: scoringSnapshot(),
  };

  it("matches computeOpportunityFreshness for fresh, stale, and undated open issues", () => {
    const nowMs = Date.now();
    const freshIssues = [
      issue(collab.fullName, 1, "Fresh", { updatedAt: new Date(nowMs - 2 * 86_400_000).toISOString() }),
    ];
    const staleIssues = [issue(collab.fullName, 2, "Stale", { updatedAt: "2020-01-01T00:00:00.000Z" })];
    const undatedIssues = [issue(collab.fullName, 3, "Undated", { updatedAt: null, createdAt: null })];

    // Inject the same clock both sides read (#8011) -- exact equality, not wall-clock-proximity equality.
    const fresh = buildRepoRewardRisk({ ...base, issues: freshIssues, pullRequests: [], nowMs });
    const stale = buildRepoRewardRisk({ ...base, issues: staleIssues, pullRequests: [], nowMs });
    const undated = buildRepoRewardRisk({ ...base, issues: undatedIssues, pullRequests: [], nowMs });

    expect(fresh.rewardUpside.opportunityFactors.freshnessFactor).toBe(
      computeOpportunityFreshness(toFreshnessIssues(freshIssues), nowMs),
    );
    expect(stale.rewardUpside.opportunityFactors.freshnessFactor).toBe(
      computeOpportunityFreshness(toFreshnessIssues(staleIssues), nowMs),
    );
    expect(undated.rewardUpside.opportunityFactors.freshnessFactor).toBe(
      computeOpportunityFreshness(toFreshnessIssues(undatedIssues), nowMs),
    );
    expect(undated.rewardUpside.opportunityFactors.freshnessFactor).toBeLessThanOrEqual(0.05);
  });

  it("uses createdAt when updatedAt is malformed", () => {
    const issuesForRisk = [
      issue(collab.fullName, 1, "Fallback", {
        updatedAt: "not-a-date",
        createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      }),
    ];
    const result = buildRepoRewardRisk({ ...base, issues: issuesForRisk, pullRequests: [] });
    expect(result.rewardUpside.opportunityFactors.freshnessFactor).toBeGreaterThan(0.7);
  });

  it("scores from the freshest open issue when multiple are present", () => {
    const issuesForRisk = [
      issue(collab.fullName, 1, "Stale", { updatedAt: "2020-01-01T00:00:00.000Z" }),
      issue(collab.fullName, 2, "Fresh", { updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    ];
    const result = buildRepoRewardRisk({ ...base, issues: issuesForRisk, pullRequests: [] });
    expect(result.rewardUpside.opportunityFactors.freshnessFactor).toBeGreaterThan(0.7);
  });

  it("is deterministic under an injected clock: same issues + same nowMs always yield the same factor (#8011)", () => {
    // A fixed epoch, no Date.now() anywhere: the factor must be a pure function of (issues, nowMs). The
    // pre-#8011 hand-duplicated issueAgeDays read the live clock, so this exact assertion was impossible.
    const fixedNowMs = Date.parse("2026-07-10T00:00:00.000Z");
    const fixedIssues = [
      issue(collab.fullName, 1, "Fixed", { updatedAt: "2026-07-08T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" }),
    ];

    const first = buildRepoRewardRisk({ ...base, issues: fixedIssues, pullRequests: [], nowMs: fixedNowMs });
    const second = buildRepoRewardRisk({ ...base, issues: fixedIssues, pullRequests: [], nowMs: fixedNowMs });

    expect(first.rewardUpside.opportunityFactors.freshnessFactor).toBe(second.rewardUpside.opportunityFactors.freshnessFactor);
    expect(first.rewardUpside.opportunityFactors.freshnessFactor).toBe(
      computeOpportunityFreshness(toFreshnessIssues(fixedIssues), fixedNowMs),
    );
    // 2 days old -> round4(exp(-2/20)) -- a concrete pin so a formula drift can't slip through as "still equal".
    expect(first.rewardUpside.opportunityFactors.freshnessFactor).toBe(0.9048);
  });
});

describe("bestFitLabels keyword anchoring", () => {
  const pick = (labelMultipliers: Record<string, number>) => {
    const base = repo("owner/repo");
    return rewardRiskFreshnessInternals.bestFitLabels({ ...base, registryConfig: { ...base.registryConfig!, labelMultipliers } });
  };
  it("excludes meta labels only at a keyword boundary, keeping mid-word matches", () => {
    // Bare keyword and prefix forms are excluded...
    expect(pick({ status: 5, bug: 2 })).toEqual(["bug"]);
    expect(pick({ "risk:high": 5, bug: 2 })).toEqual(["bug"]);
    // ...but a substring match must NOT drop a legitimate higher-multiplier label.
    expect(pick({ opensource: 5, bug: 2 })).toEqual(["opensource"]);
    expect(pick({ "risky-refactor": 5, docs: 1 })).toEqual(["risky-refactor"]);
  });
  it("returns no label when there are none, or the repo is null", () => {
    expect(pick({})).toEqual([]);
    expect(rewardRiskFreshnessInternals.bestFitLabels(null)).toEqual([]);
  });

  it("breaks an equal-multiplier tie by label name", () => {
    // Two labels with the SAME multiplier force the sort comparator's `|| localeCompare` fallback.
    expect(pick({ zebra: 1.5, alpha: 1.5 })).toEqual(["alpha"]);
  });

  it("aligns its meta-label exclusion set to engine.ts's canonical suspicious-label matcher (#7251)", () => {
    // Keywords the canonical audit excludes that the old divergent copy MISSED are now excluded here too.
    for (const key of ["state", "bot", "loopover", "reward", "score", "miner"]) {
      expect(pick({ [`${key}:x`]: 5, bug: 2 })).toEqual(["bug"]);
    }
    // `contributor` was wrongly excluded before -- the canonical audit does not treat it as suspicious, so a
    // high-multiplier contributor:* label must now surface as the best fit instead of being silently dropped.
    expect(pick({ "contributor:top-tier": 5, bug: 2 })).toEqual(["contributor:top-tier"]);
  });
});

describe("buildRepoRewardRisk — reviewChurnRisk and maintainer-cut readiness branch coverage (#2281)", () => {
  it("reviewChurnRisk reports high risk when the repo-specific closed-PR rate is high", () => {
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const churnRepo = repo("owner/churn");
    // Two closed + one merged PR => closedPullRequestRate ~0.67 => reviewChurnRisk risk >= 45 => "high".
    const outcomeHistory = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [churnRepo],
      pullRequests: [
        pr(churnRepo.fullName, 30, "Closed one", { state: "closed" }),
        pr(churnRepo.fullName, 31, "Closed two", { state: "closed" }),
        pr(churnRepo.fullName, 32, "Merged", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" }),
      ],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [churnRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: churnRepo,
      repoFullName: churnRepo.fullName,
      profile,
      outcomeHistory,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    expect(analysis.riskBreakdown.reviewChurnRisk).toBe("high");
  });

  it("reviewChurnRisk reports medium risk for a moderate closed-PR rate", () => {
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const churnRepo = repo("owner/churn-mid");
    // One closed + two merged => closedPullRequestRate ~0.33 => risk in [20, 45) => "medium".
    const outcomeHistory = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [churnRepo],
      pullRequests: [
        pr(churnRepo.fullName, 40, "Closed one", { state: "closed" }),
        pr(churnRepo.fullName, 41, "Merged one", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" }),
        pr(churnRepo.fullName, 42, "Merged two", { state: "merged", mergedAt: "2026-05-21T00:00:00.000Z" }),
      ],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [churnRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: churnRepo,
      repoFullName: churnRepo.fullName,
      profile,
      outcomeHistory,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    expect(analysis.riskBreakdown.reviewChurnRisk).toBe("medium");
  });

  it("maintainer-cut readiness scores without the low-queue bonus when the owned repo's queue is not low", () => {
    // Owner === login => maintainer lane; a heavily loaded queue keeps queueHealth.level above "low",
    // exercising the `level === "low" ? 20 : 0` false branch.
    const ownedRepo = repo("dev/owned");
    const busyPrs = Array.from({ length: 14 }, (_, i) => pr(ownedRepo.fullName, i + 1, `Open work ${i}`, { authorLogin: `other${i}` }));
    const profile = buildContributorProfile("dev", { login: "dev", topLanguages: ["TypeScript"], source: "github" }, [], []);
    const fit = buildContributorFit(profile, [ownedRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: ownedRepo,
      repoFullName: ownedRepo.fullName,
      profile,
      outcomeHistory: buildContributorOutcomeHistory({ login: "dev", profile, repositories: [ownedRepo], pullRequests: busyPrs, issues: [], repoStats: [] }),
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: busyPrs,
    });
    expect(analysis.roleContext.maintainerLane).toBe(true);
    expect(analysis.actions.some((a) => a.actionKind === "maintainer_cut_readiness")).toBe(true);
  });
});
