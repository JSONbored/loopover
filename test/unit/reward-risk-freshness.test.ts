import { describe, expect, it } from "vitest";
import {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "../../packages/gittensory-engine/src/opportunity-freshness";
import {
  buildContributorOutcomeHistory,
  buildContributorProfile,
} from "../../src/signals/engine";
import { buildRepoRewardRisk, rewardRiskFreshnessInternals } from "../../src/signals/reward-risk";
import type { IssueRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

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

describe("reward-risk freshness parity with gittensory-engine", () => {
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

    const fresh = buildRepoRewardRisk({ ...base, issues: freshIssues, pullRequests: [] });
    const stale = buildRepoRewardRisk({ ...base, issues: staleIssues, pullRequests: [] });
    const undated = buildRepoRewardRisk({ ...base, issues: undatedIssues, pullRequests: [] });

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

  it("pickIssueTimestamp and issueAgeDays cover defensive timestamp branches", () => {
    const { pickIssueTimestamp, issueAgeDays } = rewardRiskFreshnessInternals;
    expect(
      pickIssueTimestamp({
        repoFullName: collab.fullName,
        number: 1,
        title: "t",
        state: "open",
        labels: [],
        linkedPrs: [],
        updatedAt: "2026-07-03T00:00:00.000Z",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toBe("2026-07-03T00:00:00.000Z");
    expect(
      pickIssueTimestamp({
        repoFullName: collab.fullName,
        number: 2,
        title: "t",
        state: "open",
        labels: [],
        linkedPrs: [],
        updatedAt: "   ",
        createdAt: "2026-07-03T00:00:00.000Z",
      }),
    ).toBe("2026-07-03T00:00:00.000Z");
    expect(
      pickIssueTimestamp({
        repoFullName: collab.fullName,
        number: 3,
        title: "t",
        state: "open",
        labels: [],
        linkedPrs: [],
        updatedAt: null,
        createdAt: null,
      }),
    ).toBeNull();
    expect(issueAgeDays(null)).toBe(Number.POSITIVE_INFINITY);
    expect(issueAgeDays("not-a-date")).toBe(Number.POSITIVE_INFINITY);
    expect(issueAgeDays("2026-07-03T00:00:00.000Z")).toBeGreaterThanOrEqual(0);
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
});
