import { describe, expect, it } from "vitest";
import {
  computeOpportunityFreshness,
  type FreshnessIssue,
} from "../../packages/gittensory-engine/src/opportunity-freshness";
import {
  buildContributorOutcomeHistory,
  buildContributorProfile,
} from "../../src/signals/engine";
import { buildRepoRewardRisk } from "../../src/signals/reward-risk";
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
});
