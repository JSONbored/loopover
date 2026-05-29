import { describe, expect, it, vi } from "vitest";
import { persistSignalSnapshot } from "../../src/db/repositories";
import {
  __decisionPackInternals,
  loadContributorDecisionPack,
  loadContributorDecisionPackForServing,
  repoDecisionFromPack,
  type ContributorDecisionPack,
  type RepoDecision,
} from "../../src/services/decision-pack";
import { createTestEnv } from "../helpers/d1";

describe("decision-pack service", () => {
  it("classifies score blockers, recommendations, actions, and explanations deterministically", () => {
    const maintainerRole = { maintainerLane: true } as any;
    const outsideRole = { maintainerLane: false } as any;
    const pressureOutcome = { openPullRequests: 6, closedPullRequestRate: 0.4, credibility: 0.5, maintainerLane: false, mergedPullRequests: 2, closedPullRequests: 3, validSolvedIssues: 1 } as any;
    const moderateOutcome = { openPullRequests: 3, closedPullRequestRate: 0.1, credibility: 1, maintainerLane: false, mergedPullRequests: 1, closedPullRequests: 0, validSolvedIssues: 0 } as any;

    expect(__decisionPackInternals.scoreBlockersFor("owner/repo", "inactive", maintainerRole, pressureOutcome).map((blocker) => blocker.code)).toEqual([
      "maintainer_lane",
      "inactive_or_unknown_lane",
      "open_pr_pressure",
      "closed_pr_credibility",
      "low_credibility",
    ]);
    expect(__decisionPackInternals.scoreBlockersFor("owner/issues", "issue_discovery", outsideRole, undefined).map((blocker) => blocker.code)).toEqual(["issue_discovery_only"]);

    expect(__decisionPackInternals.recommendationFor("direct_pr", maintainerRole, undefined, [])).toBe("maintainer_lane");
    expect(__decisionPackInternals.recommendationFor("direct_pr", outsideRole, pressureOutcome, [{ code: "open_pr_pressure", severity: "critical" } as any])).toBe("cleanup_first");
    expect(__decisionPackInternals.recommendationFor("inactive", outsideRole, undefined, [{ code: "inactive_or_unknown_lane", severity: "critical" } as any])).toBe("avoid_for_now");
    expect(__decisionPackInternals.recommendationFor("direct_pr", outsideRole, moderateOutcome, [])).toBe("cleanup_first");
    expect(__decisionPackInternals.recommendationFor("split", outsideRole, undefined, [])).toBe("pursue");
    expect(__decisionPackInternals.recommendationFor("issue_discovery", outsideRole, undefined, [])).toBe("watch");
    expect(__decisionPackInternals.recommendationFor("unknown", outsideRole, undefined, [])).toBe("avoid_for_now");

    const baseDecision = (recommendation: RepoDecision["recommendation"], lane = "direct_pr", priorityScore = 42): RepoDecision =>
      ({
        repoFullName: "owner/repo",
        recommendation,
        priorityScore,
        lane: { lane },
        whyThisHelps: [`${recommendation} helps`],
        nextActions: [`${recommendation} next`],
      }) as RepoDecision;
    expect(__decisionPackInternals.actionsForDecision(baseDecision("maintainer_lane")).map((action) => action.actionKind)).toEqual(["maintainer_lane_improve_repo", "maintainer_cut_readiness"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("cleanup_first")).map((action) => action.actionKind)).toEqual(["cleanup_existing_prs", "land_existing_prs"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("pursue")).map((action) => action.actionKind)).toEqual(["open_new_direct_pr"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("watch", "issue_discovery")).map((action) => action.actionKind)).toEqual(["file_issue_discovery"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("avoid_for_now"))).toEqual([]);

    expect(__decisionPackInternals.whyThisHelpsFor("cleanup_first", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/cleaning up/);
    expect(__decisionPackInternals.whyThisHelpsFor("maintainer_lane", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/maintainer-owned/);
    expect(__decisionPackInternals.whyThisHelpsFor("pursue", "owner/repo", undefined, { directPrShare: 0.01234 } as any)[0]).toMatch(/0.0123/);
    expect(__decisionPackInternals.whyThisHelpsFor("watch", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/issue-discovery/);
    expect(__decisionPackInternals.whyThisHelpsFor("avoid_for_now", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/low/);

    expect(__decisionPackInternals.nextActionsFor("cleanup_first", "direct_pr")[0]).toMatch(/Close/);
    expect(__decisionPackInternals.nextActionsFor("maintainer_lane", "direct_pr")[0]).toMatch(/intake/);
    expect(__decisionPackInternals.nextActionsFor("pursue", "direct_pr")[0]).toMatch(/narrow/);
    expect(__decisionPackInternals.nextActionsFor("watch", "issue_discovery")[0]).toMatch(/high-confidence/);
    expect(__decisionPackInternals.nextActionsFor("avoid_for_now", "inactive")[0]).toMatch(/different repo/);

    expect(__decisionPackInternals.priorityFor("pursue", { directPrShare: 0.02, issueDiscoveryShare: 0, emissionShare: 0.02 } as any, moderateOutcome, { openPullRequests: 2 } as any, [])).toBeGreaterThan(0);
    expect(__decisionPackInternals.priorityFor("avoid_for_now", { directPrShare: 0, issueDiscoveryShare: 0, emissionShare: 0 } as any, pressureOutcome, { openPullRequests: 500 } as any, [{ severity: "critical" } as any])).toBe(0);
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/direct", 0.03, 0),
        roleContext: outsideRole,
        outcome: moderateOutcome,
        totals: { openPullRequestsTotal: 30, openIssuesTotal: 150, mergedPullRequestsTotal: 10, closedUnmergedPullRequestsTotal: 4 } as any,
      }).riskReasons,
    ).toEqual(expect.arrayContaining([expect.stringContaining("busy"), expect.stringContaining("large"), expect.stringContaining("open PR")]));
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/issues", 0.02, 1),
        roleContext: outsideRole,
        outcome: undefined,
        syncState: { openPullRequestsCount: 1, openIssuesCount: 2, recentMergedPullRequestsCount: 3 } as any,
      }),
    ).toMatchObject({ recommendation: "watch", queue: { openPullRequests: 1, openIssues: 2, mergedPullRequests: 3 }, rewardUpside: { issueDiscoveryShare: 0.02 } });
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/inactive", 0, 0),
        roleContext: outsideRole,
        outcome: undefined,
      }),
    ).toMatchObject({ recommendation: "avoid_for_now", scoreBlockers: [expect.objectContaining({ code: "inactive_or_unknown_lane" })] });
    expect(__decisionPackInternals.severityRank("critical")).toBe(3);
    expect(__decisionPackInternals.severityRank("warning")).toBe(2);
    expect(__decisionPackInternals.severityRank("info")).toBe(1);
    expect(__decisionPackInternals.clamp(10, 0, 5)).toBe(5);
    expect(__decisionPackInternals.round(1.23456)).toBe(1.2346);
  });

  it("redacts official hotkeys, loads stale snapshots, and resolves repo decisions case-insensitively", async () => {
    const env = createTestEnv();
    const pack = {
      status: "ready",
      source: "computed",
      login: "jsonbored",
      generatedAt: "2026-05-24T00:00:00.000Z",
      stale: false,
      scoringModelSnapshotId: "scoring-1",
      profile: { login: "jsonbored", github: {}, source: {}, officialStats: null, registeredRepoActivity: {}, trustSignals: {} },
      outcomeHistory: { login: "jsonbored", generatedAt: "2026-05-24T00:00:00.000Z", totals: {}, repoOutcomes: [] },
      roleContexts: [],
      repoDecisions: [{ repoFullName: "JSONbored/awesome-claude", recommendation: "maintainer_lane" }],
      topActions: [],
      cleanupFirst: [],
      pursueRepos: [],
      avoidRepos: [],
      maintainerLaneRepos: [],
      scoreBlockers: [],
      dataQuality: { signalFidelity: { status: "complete" } },
      summary: "fixture",
      nextActions: [],
    } as unknown as ContributorDecisionPack;

    await persistSignalSnapshot(env, {
      id: "decision-pack-1",
      signalType: "contributor-decision-pack",
      targetKey: "jsonbored",
      payload: pack as unknown as Record<string, never>,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    const loaded = await loadContributorDecisionPack(env, "jsonbored");
    expect(loaded).toMatchObject({ source: "snapshot", snapshotAgeSeconds: expect.any(Number), stale: expect.any(Boolean), freshness: "stale", rebuildEnqueued: false });
    expect(repoDecisionFromPack(loaded!, "jsonbored/AWESOME-CLAUDE")).toMatchObject({ recommendation: "maintainer_lane" });
    expect(repoDecisionFromPack(loaded!, "missing/repo")).toBeNull();

    expect(__decisionPackInternals.sanitizeOfficialStats({ gittensor: null } as any)).toBeNull();
    expect(__decisionPackInternals.sanitizeOfficialStats({ gittensor: { hotkey: "secret", totalMergedPrs: 5 } } as any)).toEqual({ totalMergedPrs: 5 });
    expect(
      __decisionPackInternals.authoritativeContributorRepoStats(
        {
          githubUsername: "JsonBored",
          repositories: [
            {
              repoFullName: "official/repo",
              pullRequests: 2,
              mergedPullRequests: 1,
              openPullRequests: 1,
              openIssues: 0,
              closedIssues: 0,
            },
          ],
        } as any,
        [{ repoFullName: "cached/repo" }] as any,
      ),
    ).toEqual([expect.objectContaining({ login: "jsonbored", repoFullName: "official/repo" })]);
    expect(__decisionPackInternals.authoritativeContributorRepoStats(null as any, [{ repoFullName: "cached/repo" }] as any)).toEqual([{ repoFullName: "cached/repo" }]);
    expect(
      __decisionPackInternals.withSnapshotMetadata({
        id: "snapshot-with-payload-date",
        signalType: "contributor-decision-pack",
        targetKey: "jsonbored",
        generatedAt: null,
        payload: { ...pack, generatedAt: "2026-05-25T00:00:00.000Z" } as any,
      }),
    ).toMatchObject({ generatedAt: "2026-05-25T00:00:00.000Z", source: "snapshot" });
    expect(__decisionPackInternals.snapshotAgeMs("not-a-date")).toBe(Number.POSITIVE_INFINITY);
  });

  it("serves fresh, stale, and missing decision packs with explicit freshness and rebuild signals", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: Record<string, unknown>) {
          sends.push(message);
        },
      } as unknown as Queue,
    });

    const missing = await loadContributorDecisionPackForServing(env, "ghost-user");
    expect(missing).toMatchObject({
      kind: "needs_refresh",
      refresh: { freshness: "missing", reason: "missing_snapshot", rebuildEnqueued: true },
    });
    expect(missing.kind === "needs_refresh" && "enqueued" in missing.refresh).toBe(false);
    expect(sends.at(-1)).toMatchObject({ type: "build-contributor-decision-packs", login: "ghost-user" });

    const stalePackPayload = {
      status: "ready",
      source: "computed",
      login: "stale-user",
      generatedAt: "2026-01-01T00:00:00.000Z",
      stale: false,
      freshness: "fresh",
      rebuildEnqueued: false,
      scoringModelSnapshotId: "scoring-1",
      profile: {},
      outcomeHistory: {},
      roleContexts: [],
      repoDecisions: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
      topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/repo", priorityScore: 50 }],
      cleanupFirst: [],
      pursueRepos: [{ repoFullName: "owner/repo", recommendation: "pursue" }],
      avoidRepos: [],
      maintainerLaneRepos: [],
      scoreBlockers: [],
      dataQuality: { signalFidelity: { status: "complete", partialRepos: [], cappedRepos: [], staleRepos: [], rateLimitedRepos: [] } },
      summary: "stale fixture",
      nextActions: ["pick a narrow change"],
    } as unknown as ContributorDecisionPack;

    await persistSignalSnapshot(env, {
      id: "stale-serving",
      signalType: "contributor-decision-pack",
      targetKey: "stale-user",
      payload: stalePackPayload as unknown as Record<string, never>,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const stale = await loadContributorDecisionPackForServing(env, "stale-user");
    expect(stale.kind).toBe("ready");
    if (stale.kind === "ready") {
      expect(stale.pack.freshness).toBe("rebuilding");
      expect(stale.pack.rebuildEnqueued).toBe(true);
      expect(stale.pack.stale).toBe(true);
      expect(stale.pack.topActions.length).toBeGreaterThan(0);
      expect(stale.pack.repoDecisions.length).toBeGreaterThan(0);
    }
    expect(sends.filter((s) => s.login === "stale-user")).toHaveLength(1);

    const staleNoEnqueue = await loadContributorDecisionPackForServing(env, "stale-user", { enqueueRebuild: false });
    expect(staleNoEnqueue.kind).toBe("ready");
    if (staleNoEnqueue.kind === "ready") {
      expect(staleNoEnqueue.pack.freshness).toBe("stale");
      expect(staleNoEnqueue.pack.rebuildEnqueued).toBe(false);
    }
    expect(sends.filter((s) => s.login === "stale-user")).toHaveLength(1);

    await persistSignalSnapshot(env, {
      id: "fresh-serving",
      signalType: "contributor-decision-pack",
      targetKey: "fresh-user",
      payload: {
        ...stalePackPayload,
        login: "fresh-user",
        generatedAt: new Date(Date.now() - 60_000).toISOString(),
      } as unknown as Record<string, never>,
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const sendsBefore = sends.length;
    const fresh = await loadContributorDecisionPackForServing(env, "fresh-user");
    expect(fresh.kind).toBe("ready");
    if (fresh.kind === "ready") {
      expect(fresh.pack.freshness).toBe("fresh");
      expect(fresh.pack.rebuildEnqueued).toBe(false);
      expect(fresh.pack.stale).toBe(false);
    }
    expect(sends.length).toBe(sendsBefore);

    const enqueueErrorEnv = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue down");
        },
      } as unknown as Queue,
    });
    const missingNoEnqueue = await loadContributorDecisionPackForServing(enqueueErrorEnv, "any-user");
    expect(missingNoEnqueue).toMatchObject({
      kind: "needs_refresh",
      refresh: { freshness: "missing", rebuildEnqueued: false },
    });
  });

  it("does not call broad contributor or repo listers on the serving path", async () => {
    const env = createTestEnv();
    const broadListers = await import("../../src/db/repositories");
    const spies = [
      vi.spyOn(broadListers, "listContributorPullRequests"),
      vi.spyOn(broadListers, "listContributorIssues"),
      vi.spyOn(broadListers, "listContributorRepoStats"),
      vi.spyOn(broadListers, "listRepositories"),
      vi.spyOn(broadListers, "listRepoSyncStates"),
      vi.spyOn(broadListers, "listRepoSyncSegments"),
      vi.spyOn(broadListers, "listLatestRepoGithubTotalsSnapshots"),
    ];

    await loadContributorDecisionPackForServing(env, "ghost-user");

    await persistSignalSnapshot(env, {
      id: "perf-stale-pack",
      signalType: "contributor-decision-pack",
      targetKey: "perf-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "perf-user",
        generatedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [],
        topActions: [],
        cleanupFirst: [],
        pursueRepos: [],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "degraded" } },
        summary: "stale",
        nextActions: [],
      } as unknown as Record<string, never>,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    await loadContributorDecisionPackForServing(env, "perf-user");

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("debounces repeated stale-pack rebuild requests via the audit log", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: Record<string, unknown>) {
          sends.push(message);
        },
      } as unknown as Queue,
    });
    await persistSignalSnapshot(env, {
      id: "debounce-stale",
      signalType: "contributor-decision-pack",
      targetKey: "hot-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "hot-user",
        generatedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [],
        topActions: [],
        cleanupFirst: [],
        pursueRepos: [],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "complete" } },
        summary: "stale",
        nextActions: [],
      } as unknown as Record<string, never>,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    for (let i = 0; i < 5; i++) {
      const result = await loadContributorDecisionPackForServing(env, "hot-user");
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        expect(result.pack.freshness).toBe("rebuilding");
        expect(result.pack.rebuildEnqueued).toBe(true);
      }
    }
    expect(sends.filter((s) => s.login === "hot-user")).toHaveLength(1);
  });

  it("returns freshness:missing with rebuildEnqueued:false when enqueueRebuild is disabled and no snapshot exists", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: Record<string, unknown>) {
          sends.push(message);
        },
      } as unknown as Queue,
    });
    const result = await loadContributorDecisionPackForServing(env, "ghost", { enqueueRebuild: false });
    expect(result.kind).toBe("needs_refresh");
    if (result.kind === "needs_refresh") {
      expect(result.refresh.rebuildEnqueued).toBe(false);
      expect(result.refresh.freshness).toBe("missing");
    }
    expect(sends).toHaveLength(0);
  });

  it("covers scoreBlockersFor and withSnapshotMetadata fallback branches", () => {
    const noOutcomeBlockers = __decisionPackInternals.scoreBlockersFor("owner/x", "direct_pr", { maintainerLane: false } as any, undefined);
    expect(noOutcomeBlockers.map((b) => b.code)).not.toContain("open_pr_pressure");
    expect(noOutcomeBlockers.map((b) => b.code)).not.toContain("closed_pr_credibility");
    expect(noOutcomeBlockers.map((b) => b.code)).not.toContain("low_credibility");

    const fellbackToNow = __decisionPackInternals.withSnapshotMetadata({
      id: "snap-both-null",
      signalType: "contributor-decision-pack",
      targetKey: "user",
      generatedAt: null,
      payload: { status: "ready", source: "computed", login: "user", repoDecisions: [], topActions: [] } as any,
    });
    expect(typeof fellbackToNow.generatedAt).toBe("string");
    expect(fellbackToNow.generatedAt.length).toBeGreaterThan(0);
  });

  it("records non-Error queue failures with String(error) detail", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw "queue offline string";
        },
      } as unknown as Queue,
    });
    const result = await loadContributorDecisionPackForServing(env, "string-throw-user");
    expect(result.kind).toBe("needs_refresh");
    if (result.kind === "needs_refresh") {
      expect(result.refresh.rebuildEnqueued).toBe(false);
    }
    const rows = ((await env.DB.prepare("SELECT detail FROM audit_events WHERE event_type='decision_pack.rebuild_enqueue_failed'").all()) as { results: Array<{ detail: string }> }).results;
    expect(rows[0]?.detail).toContain("queue offline string");
  });

  it("returns freshness:stale with rebuildEnqueued:false when a stale pack is served and the queue throws", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue offline");
        },
      } as unknown as Queue,
    });
    await persistSignalSnapshot(env, {
      id: "stale-queue-down",
      signalType: "contributor-decision-pack",
      targetKey: "queue-down-user",
      payload: {
        status: "ready",
        source: "computed",
        login: "queue-down-user",
        generatedAt: "2026-01-01T00:00:00.000Z",
        stale: false,
        freshness: "fresh",
        rebuildEnqueued: false,
        scoringModelSnapshotId: "scoring-1",
        profile: {},
        outcomeHistory: {},
        roleContexts: [],
        repoDecisions: [{ repoFullName: "owner/r", recommendation: "pursue" }],
        topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/r", priorityScore: 1 }],
        cleanupFirst: [],
        pursueRepos: [],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: [],
        dataQuality: { signalFidelity: { status: "complete" } },
        summary: "stale",
        nextActions: [],
      } as unknown as Record<string, never>,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await loadContributorDecisionPackForServing(env, "queue-down-user");
    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.pack.freshness).toBe("stale");
      expect(result.pack.rebuildEnqueued).toBe(false);
      expect(result.pack.topActions.length).toBeGreaterThan(0);
    }
    const auditRows = ((await env.DB.prepare("SELECT event_type FROM audit_events").all()) as { results: Array<{ event_type: string }> }).results;
    expect(auditRows.map((r) => r.event_type)).toContain("decision_pack.rebuild_enqueue_failed");
    expect(auditRows.map((r) => r.event_type)).not.toContain("decision_pack.rebuild_enqueued");
  });

  it("builds a snapshot-style decision pack with maintainer, cleanup, pursue, watch, and avoid lanes", () => {
    const profile = {
      login: "jsonbored",
      generatedAt: "2026-05-25T00:00:00.000Z",
      github: {},
      source: {},
      gittensor: null,
      registeredRepoActivity: { reposTouched: ["owner/cleanup", "owner/pursue", "owner/issues"] },
      trustSignals: {},
    } as any;
    const outcomeHistory = {
      login: "jsonbored",
      generatedAt: "2026-05-25T00:00:00.000Z",
      source: {},
      totals: {},
      repoOutcomes: [
        { repoFullName: "owner/cleanup", role: "outside_contributor", lane: "direct_pr", maintainerLane: false, openPullRequests: 6, closedPullRequestRate: 0.4, credibility: 0.5, mergedPullRequests: 1, closedPullRequests: 2, validSolvedIssues: 0 },
        { repoFullName: "owner/pursue", role: "outside_contributor", lane: "split", maintainerLane: false, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1, mergedPullRequests: 3, closedPullRequests: 0, validSolvedIssues: 1 },
      ],
      successPatterns: [],
      failurePatterns: [],
      summary: "fixture",
    } as any;

    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "jsonbored",
      profile,
      outcomeHistory,
      repositories: [
        repo("jsonbored/owned", 0.02, 0),
        repo("owner/cleanup", 0.03, 0),
        repo("owner/pursue", 0.04, 0.5),
        repo("owner/issues", 0.01, 1),
        repo("owner/inactive", 0, 0),
        { ...repo("owner/unconfigured", 0.01, 0), registryConfig: null },
        { ...repo("owner/unregistered", 0.01, 0), isRegistered: false },
      ],
      syncStates: [
        { repoFullName: "owner/cleanup", status: "complete", openPullRequestsCount: 30, openIssuesCount: 150, recentMergedPullRequestsCount: 5, warnings: [], lastCompletedAt: "2026-05-25T00:00:00.000Z" },
        { repoFullName: "owner/inactive", status: "complete", openPullRequestsCount: 0, openIssuesCount: 0, recentMergedPullRequestsCount: 0, warnings: [], lastCompletedAt: "2026-05-25T00:00:00.000Z" },
      ] as any,
      syncSegments: [],
      totals: [{ repoFullName: "owner/pursue", openPullRequestsTotal: 2, openIssuesTotal: 3, mergedPullRequestsTotal: 4, closedUnmergedPullRequestsTotal: 1 }] as any,
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [{ repoFullName: "owner/cleanup", authorLogin: "jsonbored", authorAssociation: "CONTRIBUTOR" }] as any,
      contributorIssues: [],
    });

    expect(pack.repoDecisions).toHaveLength(6);
    expect(pack.maintainerLaneRepos.map((decision) => decision.repoFullName)).toContain("jsonbored/owned");
    expect(pack.cleanupFirst.map((decision) => decision.repoFullName)).toContain("owner/cleanup");
    expect(pack.pursueRepos.map((decision) => decision.repoFullName)).toContain("owner/pursue");
    expect(pack.avoidRepos.map((decision) => decision.repoFullName)).toEqual(expect.arrayContaining(["owner/inactive", "owner/unconfigured"]));
    expect(pack.topActions.map((action) => action.actionKind)).toEqual(expect.arrayContaining(["maintainer_lane_improve_repo", "cleanup_existing_prs", "open_new_direct_pr", "file_issue_discovery"]));
    expect(pack.roleContexts.map((role) => role.repoFullName)).not.toContain("owner/unconfigured");
    expect(pack.nextActions.length).toBeGreaterThan(0);
  });
});

function repo(fullName: string, emissionShare: number, issueDiscoveryShare: number) {
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
      emissionShare,
      issueDiscoveryShare,
      maintainerCut: 0,
      labelMultipliers: {},
      raw: {},
    },
  } as any;
}
