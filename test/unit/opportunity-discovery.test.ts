import { describe, expect, it } from "vitest";
import { upsertIssueWatchSubscription } from "../../src/db/repositories";
import { buildOpportunityDiscoveryResult, detectDecisionPackOpportunityEvents } from "../../src/services/opportunity-discovery";
import type { ContributorDecisionPack } from "../../src/services/decision-pack";
import type { ContributorOpportunity } from "../../src/signals/engine";
import type { IssueRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function opportunity(over: Partial<ContributorOpportunity> = {}): ContributorOpportunity {
  return {
    repoFullName: "owner/repo",
    issueNumber: 7,
    title: "Ship cached ranking",
    fit: "good",
    score: 91,
    lane: "split",
    multiplierTier: "maintainer_created",
    availability: "ready",
    reasons: ["Repository is configured for both issue discovery and direct PR review.", "Issue quality report rates this issue as ready."],
    warnings: [],
    ...over,
  };
}

function pack(opportunities: ContributorOpportunity[]): ContributorDecisionPack {
  return {
    status: "ready",
    source: "snapshot",
    login: "miner",
    generatedAt: "2026-06-23T00:00:00.000Z",
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: "snapshot",
    profile: {
      login: "miner",
      github: { login: "miner", name: null, followers: 0, publicRepos: 0, topLanguages: [], source: "github" },
      source: "github_cache",
      officialStats: null,
      registeredRepoActivity: { reposTouched: [], pullRequests: 0, mergedPullRequests: 0, dominantLabels: [] },
      trustSignals: { evidenceScore: 0, level: "new", unlinkedOpenPullRequests: 0, maintainerAssociatedPullRequests: 0 },
    },
    outcomeHistory: { login: "miner", generatedAt: "2026-06-23T00:00:00.000Z", source: "github_cache", totals: { pullRequests: 0, mergedPullRequests: 0, openPullRequests: 0, issues: 0 }, repoOutcomes: [] },
    roleContexts: [],
    opportunities,
    repoDecisions: [],
    topActions: [],
    actionPortfolio: { generatedAt: "2026-06-23T00:00:00.000Z", bucketOrder: [], buckets: [], topActions: [], counts: { cleanup: 0, wait: 0, direct_pr: 0, issue_discovery: 0, avoid: 0, maintainer_lane: 0 }, summary: "" },
    cleanupFirst: [],
    pursueRepos: [],
    avoidRepos: [],
    maintainerLaneRepos: [],
    scoreBlockers: [],
    recommendationOutcomeFeedback: { totals: { total: 0, positive: 0, negative: 0, merged: 0, rejected: 0, closed: 0, stale: 0, ignored: 0, improved: 0, maintainerLaneTotal: 0 }, repos: [] } as never,
    dataQuality: { signalFidelity: { status: "complete", warnings: [], updatedAt: "2026-06-23T00:00:00.000Z" } as never },
    summary: "",
    nextActions: [],
  } as unknown as ContributorDecisionPack;
}

describe("buildOpportunityDiscoveryResult", () => {
  it("returns a deterministic cross-repo shortlist without exposing raw scores", () => {
    const result = buildOpportunityDiscoveryResult(
      pack([
        opportunity({ repoFullName: "owner/repo", issueNumber: 7, title: "Ship cached ranking" }),
        opportunity({ repoFullName: "other/repo", issueNumber: 11, title: "Tighten docs", lane: "direct_pr", multiplierTier: "community", score: 70 }),
      ]),
      [
        { repoFullName: "owner/repo", number: 7, title: "Ship cached ranking", state: "open", labels: ["bug"], linkedPrs: [], createdAt: "2026-06-22T00:00:00.000Z" },
        { repoFullName: "other/repo", number: 11, title: "Tighten docs", state: "open", labels: ["docs"], linkedPrs: [], createdAt: "2026-05-01T00:00:00.000Z" },
      ],
      { lanes: ["split"], labels: ["bug"], freshnessDays: 14 },
    );
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toMatchObject({
      repoFullName: "owner/repo",
      issueNumber: 7,
      lane: "split",
      labels: ["bug"],
    });
    expect(JSON.stringify(result)).not.toMatch(/\"score\":/);
  });
});

describe("detectDecisionPackOpportunityEvents", () => {
  it("emits a reprioritized alert for a matching top-ranked watched issue", async () => {
    const env = createTestEnv();
    await upsertIssueWatchSubscription(env, { login: "miner", repoFullName: "owner/repo", lanes: ["split"], labels: ["bug"], freshnessDays: 30 });
    const events = await detectDecisionPackOpportunityEvents(
      env,
      pack([opportunity({ repoFullName: "owner/repo", issueNumber: 7, title: "Ship cached ranking" })]),
      [{ repoFullName: "owner/repo", number: 7, title: "Ship cached ranking", state: "open", labels: ["bug"], linkedPrs: [], createdAt: "2026-06-20T00:00:00.000Z", authorLogin: "maintainer" } satisfies IssueRecord],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "issue_watch_match",
      trigger: "reprioritized",
      recipientLogin: "miner",
      repoFullName: "owner/repo",
      pullNumber: 7,
    });
  });
});
