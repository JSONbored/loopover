import { describe, expect, it } from "vitest";
import {
  buildMinerDashboardNextActions,
  buildMinerDashboardRepoFit,
  previousDecisionPackFromSnapshots,
} from "../../src/services/miner-dashboard-recommendations";
import type { ContributorDecisionPack } from "../../src/services/decision-pack";
import type { SignalSnapshotRecord } from "../../src/types";

const FORBIDDEN_PUBLIC_CHANGE_TEXT =
  /wallet|hotkey|coldkey|raw trust|trust[-\s]?score|payout|reward[-\s]?estimate|farming|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)|private[-\s]?scoreability|scoreability|\/Users|\/home|\/tmp|github_pat|ghp_/i;

describe("miner dashboard recommendation metadata", () => {
  it("builds deterministic changed-since-last-run labels and grouped rerun reasons", () => {
    const previous = decisionPack({
      generatedAt: "2026-06-01T00:00:00.000Z",
      repoDecisions: [
        repoDecision({
          recommendation: "watch",
          priorityScore: 35,
          queue: { openPullRequests: 0, openIssues: 1, mergedPullRequests: 0, closedUnmergedPullRequests: 0 },
          scoreBlockers: [],
          manifestSummary: {
            linkedIssuePolicy: "optional",
            issueDiscoveryPolicy: "allowed",
            wantedPathCount: 1,
            blockedPathCount: 0,
          },
        }),
      ],
      topActions: [action({ recommendation: "watch", priorityScore: 35 })],
      pursueRepos: [repoDecision({ recommendation: "watch", priorityScore: 35 })],
      dataQuality: { signalFidelity: { status: "complete" } },
    });
    const current = decisionPack({
      generatedAt: "2026-06-02T00:00:00.000Z",
      repoDecisions: [
        repoDecision({
          recommendation: "pursue",
          priorityScore: 82,
          queue: { openPullRequests: 3, openIssues: 4, mergedPullRequests: 1, closedUnmergedPullRequests: 0 },
          scoreBlockers: [{ code: "open_pr_pressure", detail: "wallet hotkey scoreability reward estimate" }],
          manifestSummary: {
            linkedIssuePolicy: "required",
            issueDiscoveryPolicy: "restricted",
            wantedPathCount: 2,
            blockedPathCount: 1,
          },
        }),
      ],
      topActions: [action({ recommendation: "pursue", priorityScore: 82 })],
      actionPortfolio: {
        topActions: [
          {
            repoFullName: "JSONbored/gittensory",
            actionKind: "open_new_direct_pr",
            rerunWhen: "Rerun when queue changes, not wallet hotkey scoreability reward estimate.",
          },
        ],
      },
      pursueRepos: [repoDecision({ recommendation: "pursue", priorityScore: 82 })],
      dataQuality: { signalFidelity: { status: "degraded" } },
    });

    const [enriched] = buildMinerDashboardNextActions(current, previous);

    expect(enriched?.change).toMatchObject({
      status: "changed",
      labels: expect.arrayContaining([
        expect.objectContaining({ kind: "repo_state", label: "Recommendation changed", before: "watch", after: "pursue" }),
        expect.objectContaining({ kind: "repo_state", label: "Priority bucket changed", before: "low", after: "high" }),
        expect.objectContaining({ kind: "repo_state", label: "Queue changed", before: "0 PR / 1 issue", after: "3 PR / 4 issue" }),
        expect.objectContaining({ kind: "validation_state", label: "Validation blockers changed", before: "none", after: "open_pr_pressure" }),
        expect.objectContaining({ kind: "policy_context", label: "Context freshness changed", before: "complete", after: "degraded" }),
      ]),
    });
    expect(enriched?.rerunReasons.map((group) => group.group)).toEqual([
      "repo_state",
      "contributor_state",
      "validation_state",
      "policy_context",
    ]);
    expect(JSON.stringify({ change: enriched?.change, rerunReasons: enriched?.rerunReasons })).not.toMatch(FORBIDDEN_PUBLIC_CHANGE_TEXT);
  });

  it("marks unchanged recommendations when tracked evidence is stable", () => {
    const previous = decisionPack({ generatedAt: "2026-06-01T00:00:00.000Z" });
    const current = decisionPack({ generatedAt: "2026-06-02T00:00:00.000Z" });

    const [enriched] = buildMinerDashboardNextActions(current, previous);

    expect(enriched?.change).toEqual({
      status: "unchanged",
      summary: "No tracked evidence changed since the previous run.",
      labels: [],
    });
  });

  it("marks new recommendations and builds fallback rerun groups for sparse records", () => {
    const current = decisionPack({
      repoDecisions: [
        repoDecision({
          repoFullName: "owner/sparse",
          recommendation: "avoid_for_now",
          priorityScore: 0,
          queue: {},
          outcome: { openPullRequests: 2 },
          roleContext: { lane: "issue_discovery", maintainerLane: true },
          scoreBlockers: [{}],
          manifestSummary: {},
        }),
      ],
      topActions: [{ repoFullName: "owner/sparse", recommendation: "avoid_for_now", priorityScore: 0 }],
      actionPortfolio: { topActions: [] },
      pursueRepos: [],
      avoidRepos: [repoDecision({ repoFullName: "owner/sparse", recommendation: "avoid_for_now", priorityScore: 0 })],
      maintainerLaneRepos: [repoDecision({ repoFullName: "owner/maintainer", recommendation: "maintainer_lane" })],
    });

    const [action] = buildMinerDashboardNextActions(current);
    const repoFit = buildMinerDashboardRepoFit(current);

    expect(action?.change).toEqual({
      status: "new",
      summary: "New since the previous decision-pack run.",
      labels: [{ kind: "repo_state", label: "New recommendation" }],
    });
    expect(action?.rerunReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "contributor_state", reasons: expect.arrayContaining(["Rerun after your existing PRs in this repo merge, close, or are updated."]) }),
        expect.objectContaining({ group: "validation_state", reasons: expect.arrayContaining(["Rerun after validation blockers change: validation_1."]) }),
      ]),
    );
    expect(repoFit.map((repo) => repo.lane)).toEqual(["maintainer-lane", "avoid"]);
  });

  it("reports medium-to-none priority changes", () => {
    const previous = decisionPack({
      generatedAt: "2026-06-01T00:00:00.000Z",
      repoDecisions: [repoDecision({ priorityScore: 45, roleContext: { role: "contributor", maintainerLane: true } })],
      topActions: [action({ priorityScore: 45 })],
    });
    const current = decisionPack({
      generatedAt: "2026-06-02T00:00:00.000Z",
      repoDecisions: [repoDecision({ priorityScore: 0, roleContext: { role: "contributor", maintainerLane: true } })],
      topActions: [action({ priorityScore: 0 })],
    });

    expect(buildMinerDashboardNextActions(current, previous)[0]?.change.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "repo_state", label: "Priority bucket changed", before: "medium", after: "none" }),
      ]),
    );
  });

  it("falls back to decision evidence when action and repo-fit rows are sparse", () => {
    const previous = decisionPack({
      generatedAt: "2026-06-01T00:00:00.000Z",
      repoDecisions: [
        {
          repoFullName: "owner/fallback",
          recommendation: "watch",
          priorityScore: 45,
          scoreBlockers: [],
          manifestSummary: {},
        },
      ],
      topActions: [
        {},
        { repoFullName: "owner/fallback", actionKind: "file_issue_discovery" },
        { repoFullName: "owner/fallback", actionKind: "duplicate_entry" },
      ],
      pursueRepos: [{ recommendation: "watch" }],
    });
    const current = decisionPack({
      generatedAt: "2026-06-02T00:00:00.000Z",
      repoDecisions: [
        {
          repoFullName: "owner/fallback",
          recommendation: "pursue",
          priorityScore: 0,
          scoreBlockers: [],
          manifestSummary: {
            linkedIssuePolicy: "required",
            issueDiscoveryPolicy: "restricted",
            wantedPathCount: 2,
            blockedPathCount: 1,
          },
        },
      ],
      topActions: [
        { actionKind: "open_new_direct_pr" },
        { repoFullName: "owner/fallback", actionKind: "open_new_direct_pr" },
      ],
      pursueRepos: [{ recommendation: "pursue" }, { repoFullName: "owner/fallback", recommendation: "pursue" }],
    });

    const [, fallbackAction] = buildMinerDashboardNextActions(current, previous);
    const [repoWithoutName] = buildMinerDashboardRepoFit(current, previous);

    expect(fallbackAction?.change.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Action changed", before: "file_issue_discovery", after: "open_new_direct_pr" }),
        expect.objectContaining({ label: "Recommendation changed", before: "watch", after: "pursue" }),
        expect.objectContaining({ label: "Priority bucket changed", before: "medium", after: "none" }),
        expect.objectContaining({ label: "Repo policy changed", before: "unknown/unknown/0 wanted/0 blocked", after: "required/restricted/2 wanted/1 blocked" }),
      ]),
    );
    expect(repoWithoutName?.change.status).toBe("new");
  });

  it("adds lane change evidence to repo fit rows", () => {
    const previous = decisionPack({
      generatedAt: "2026-06-01T00:00:00.000Z",
      pursueRepos: [repoDecision({ recommendation: "pursue" })],
    });
    const current = decisionPack({
      generatedAt: "2026-06-02T00:00:00.000Z",
      cleanupFirst: [repoDecision({ recommendation: "cleanup_first" })],
      pursueRepos: [],
    });

    const [repoFit] = buildMinerDashboardRepoFit(current, previous);

    expect(repoFit?.change).toMatchObject({
      status: "changed",
      labels: expect.arrayContaining([
        expect.objectContaining({ kind: "repo_state", label: "Lane changed", before: "pursue", after: "cleanup-first" }),
      ]),
    });
  });

  it("handles repo-fit fallback rows with sparse optional evidence", () => {
    const previous = decisionPack({
      generatedAt: "2026-06-01T00:00:00.000Z",
      repoDecisions: [],
      topActions: [],
      pursueRepos: [
        {
          repoFullName: "owner/sparse-fit",
          recommendation: "watch",
          priorityScore: 45,
          queue: {},
          outcome: {},
          roleContext: { lane: "review" },
        },
      ],
    });
    const current = decisionPack({
      generatedAt: "2026-06-02T00:00:00.000Z",
      repoDecisions: [],
      topActions: [],
      pursueRepos: [
        {
          repoFullName: "owner/sparse-fit",
          queue: {},
          outcome: {},
          roleContext: {},
        },
      ],
    });

    const [repoFit] = buildMinerDashboardRepoFit(current, previous);
    const recommendationChange = repoFit?.change.labels.find((label) => label.label === "Recommendation changed");
    const priorityChange = repoFit?.change.labels.find((label) => label.label === "Priority bucket changed");

    expect(repoFit?.change).toMatchObject({
      status: "changed",
      labels: expect.arrayContaining([
        expect.objectContaining({ kind: "repo_state", label: "Recommendation changed", before: "watch" }),
        expect.objectContaining({ kind: "repo_state", label: "Priority bucket changed", before: "medium" }),
        expect.objectContaining({ kind: "contributor_state", label: "Contributor lane changed", before: "review", after: "contributor" }),
      ]),
    });
    expect(recommendationChange).not.toHaveProperty("after");
    expect(priorityChange).not.toHaveProperty("after");
  });

  it("selects the previous ready decision-pack snapshot", () => {
    const current = decisionPack({ generatedAt: "2026-06-02T00:00:00.000Z" });
    const previous = decisionPack({ generatedAt: "2026-06-01T00:00:00.000Z" });

    expect(previousDecisionPackFromSnapshots(current, [snapshot("current", current), snapshot("previous", previous)])?.generatedAt).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  it("skips non-ready and current decision-pack snapshots", () => {
    const current = decisionPack({ generatedAt: "2026-06-02T00:00:00.000Z" });

    expect(
      previousDecisionPackFromSnapshots(current, [
        {
          id: "refresh",
          signalType: "contributor-decision-pack",
          targetKey: "miner",
          payload: { status: "needs_snapshot_refresh", generatedAt: "2026-06-01T00:00:00.000Z" },
          generatedAt: "2026-06-01T00:00:00.000Z",
        } as SignalSnapshotRecord,
        snapshot("current", current),
      ]),
    ).toBeUndefined();
  });

  it("uses the snapshot timestamp when a previous ready payload has no generatedAt", () => {
    const current = decisionPack({ generatedAt: "2026-06-02T00:00:00.000Z" });
    const previous = decisionPack({ generatedAt: undefined });

    expect(
      previousDecisionPackFromSnapshots(current, [
        {
          ...snapshot("previous", previous),
          payload: { ...previous, generatedAt: undefined } as unknown as SignalSnapshotRecord["payload"],
          generatedAt: "2026-06-01T00:00:00.000Z",
        },
      ])?.login,
    ).toBe("miner");
  });
});

function decisionPack(overrides: Record<string, unknown> = {}): ContributorDecisionPack {
  return {
    status: "ready",
    source: "computed",
    login: "miner",
    generatedAt: "2026-06-02T00:00:00.000Z",
    stale: false,
    freshness: "fresh",
    rebuildEnqueued: false,
    scoringModelSnapshotId: "scoring-1",
    repoDecisions: [repoDecision()],
    topActions: [action()],
    actionPortfolio: { topActions: [] },
    cleanupFirst: [],
    pursueRepos: [repoDecision()],
    avoidRepos: [],
    maintainerLaneRepos: [],
    scoreBlockers: [],
    dataQuality: { signalFidelity: { status: "complete" } },
    ...overrides,
  } as unknown as ContributorDecisionPack;
}

function repoDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoFullName: "JSONbored/gittensory",
    recommendation: "pursue",
    priorityScore: 82,
    queue: { openPullRequests: 1, openIssues: 2, mergedPullRequests: 1, closedUnmergedPullRequests: 0 },
    outcome: { openPullRequests: 0, mergedPullRequests: 1, closedPullRequests: 0 },
    roleContext: { role: "contributor", maintainerLane: false },
    scoreBlockers: [],
    manifestSummary: {
      linkedIssuePolicy: "required",
      issueDiscoveryPolicy: "allowed",
      wantedPathCount: 1,
      blockedPathCount: 0,
    },
    ...overrides,
  };
}

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoFullName: "JSONbored/gittensory",
    actionKind: "open_new_direct_pr",
    recommendation: "pursue",
    priorityScore: 82,
    whyThisHelps: ["Pick a narrow, public-safe change."],
    nextActions: ["Run local preflight."],
    publicNextActions: ["Run local preflight."],
    ...overrides,
  };
}

function snapshot(id: string, pack: ContributorDecisionPack): SignalSnapshotRecord {
  return {
    id,
    signalType: "contributor-decision-pack",
    targetKey: "miner",
    payload: pack as unknown as SignalSnapshotRecord["payload"],
    generatedAt: pack.generatedAt,
  };
}
