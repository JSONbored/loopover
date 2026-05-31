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

    const ctxFor = (lane: string, overrides: Record<string, unknown> = {}) =>
      ({
        repoFullName: "owner/repo",
        lane,
        queue: { openPullRequests: 0, openIssues: 0, mergedPullRequests: 0, closedUnmergedPullRequests: 0 },
        rewardUpside: { directPrShare: 0.0123, issueDiscoveryShare: 0, emissionShare: 0.01, maintainerCut: 0 },
        outcome: undefined,
        languageMatch: { language: null, match: false },
        labelFit: [],
        roleContext: outsideRole,
        ...overrides,
      }) as any;
    expect(__decisionPackInternals.whyThisHelpsFor("cleanup_first", ctxFor("direct_pr", { outcome: pressureOutcome }))[0]).toMatch(/block scoreability/);
    expect(__decisionPackInternals.whyThisHelpsFor("maintainer_lane", ctxFor("direct_pr"))[0]).toMatch(/maintainer-owned/);
    expect(__decisionPackInternals.whyThisHelpsFor("pursue", ctxFor("direct_pr"))[0]).toMatch(/0.0123/);
    expect(__decisionPackInternals.whyThisHelpsFor("watch", ctxFor("issue_discovery"))[0]).toMatch(/issue-discovery-only/);
    expect(__decisionPackInternals.whyThisHelpsFor("avoid_for_now", ctxFor("inactive"))[0]).toMatch(/low/);

    expect(__decisionPackInternals.nextActionsFor("cleanup_first", ctxFor("direct_pr", { outcome: pressureOutcome }))[0]).toMatch(/close, update, or land/);
    expect(__decisionPackInternals.nextActionsFor("maintainer_lane", ctxFor("direct_pr"))[0]).toMatch(/intake health/);
    expect(__decisionPackInternals.nextActionsFor("pursue", ctxFor("direct_pr"))[0]).toMatch(/narrow change/);
    expect(__decisionPackInternals.nextActionsFor("watch", ctxFor("issue_discovery"))[0]).toMatch(/non-duplicate/);
    expect(__decisionPackInternals.nextActionsFor("avoid_for_now", ctxFor("inactive"))[0]).toMatch(/different repo/);

    expect(__decisionPackInternals.publicNextActionsFor("cleanup_first", ctxFor("direct_pr", { outcome: pressureOutcome }))[0]).not.toMatch(/\d/);
    expect(__decisionPackInternals.publicNextActionsFor("pursue", ctxFor("direct_pr"))[0]).toMatch(/preflight/);

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
    let releaseSend!: () => void;
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const sendReleased = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const env = createTestEnv({
      JOBS: {
        async send(message: Record<string, unknown>) {
          sends.push(message);
          markSendStarted();
          await sendReleased;
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

    const first = loadContributorDecisionPackForServing(env, "hot-user");
    const racing = Array.from({ length: 3 }, () => loadContributorDecisionPackForServing(env, "hot-user"));
    await sendStarted;
    const joined = Array.from({ length: 2 }, () => loadContributorDecisionPackForServing(env, "hot-user"));
    releaseSend();
    const results = await Promise.all([first, ...racing, ...joined]);
    for (const result of results) {
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") {
        expect(result.pack.freshness).toBe("rebuilding");
        expect(result.pack.rebuildEnqueued).toBe(true);
      }
    }
    expect(sends.filter((s) => s.login === "hot-user")).toHaveLength(1);

    const afterAuditDebounce = await loadContributorDecisionPackForServing(env, "hot-user");
    expect(afterAuditDebounce).toMatchObject({ kind: "ready", pack: { freshness: "rebuilding", rebuildEnqueued: true } });
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

    const belowThresholdBlockers = __decisionPackInternals.scoreBlockersFor(
      "owner/healthy",
      "direct_pr",
      { maintainerLane: false } as any,
      { openPullRequests: 1, closedPullRequestRate: 0.1, credibility: 1, maintainerLane: false } as any,
    );
    expect(belowThresholdBlockers.map((b) => b.code)).not.toEqual(expect.arrayContaining(["open_pr_pressure", "closed_pr_credibility", "low_credibility"]));

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
      openPrMonitor: emptyOpenPrMonitor("jsonbored"),
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

  it("issues repo-specific direct-PR reasoning that names language and label fit", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/direct", 0.04, 0, { bug: 1.2, "good-first-issue": 1.1, perf: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 3, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript", "python"]),
      labelHistory: new Set(["bug", "good-first-issue"]),
    });
    expect(decision.recommendation).toBe("pursue");
    expect(decision.lane.lane).toBe("direct_pr");
    expect(decision.languageMatch).toEqual({ language: "TypeScript", match: true });
    expect(decision.labelFit).toEqual(expect.arrayContaining(["bug", "good-first-issue"]));
    expect(decision.nextActions[0]).toMatch(/in TypeScript/);
    expect(decision.nextActions[0]).toMatch(/bug, good-first-issue/);
    expect(decision.whyThisHelps[0]).toMatch(/3 merged PR/);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("issues split-lane reasoning distinct from direct-PR copy", () => {
    const split = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/split", 0.04, 0.5, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    const directOnly = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/direct-only", 0.04, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(split.recommendation).toBe("pursue");
    expect(split.lane.lane).toBe("split");
    expect(split.nextActions[0]).toMatch(/split lane/);
    expect(split.whyThisHelps[0]).toMatch(/split lane/);
    expect(split.nextActions[0]).not.toEqual(directOnly.nextActions[0]);
    expect(split.whyThisHelps[0]).not.toEqual(directOnly.whyThisHelps[0]);
    expect(noStructuralCountLeak(split.publicNextActions)).toBe(true);
  });

  it("issues issue-discovery-only reasoning that discourages direct PRs", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/issues", 0.02, 1, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      syncState: { primaryLanguage: "TypeScript", openIssuesCount: 42 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(decision.recommendation).toBe("watch");
    expect(decision.lane.lane).toBe("issue_discovery");
    expect(decision.nextActions[0]).toMatch(/non-duplicate/);
    expect(decision.nextActions[0]).toMatch(/Open issues in queue: 42/);
    expect(decision.whyThisHelps[0]).toMatch(/issue-discovery-only/);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("uses issue-quality candidates in issue-discovery next actions", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/issues", 0.02, 1, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      syncState: { primaryLanguage: "TypeScript", openIssuesCount: 42 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      issueQuality: {
        repoFullName: "owner/issues",
        generatedAt: "2026-05-29T00:00:00.000Z",
        lane: { repoFullName: "owner/issues", lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [
          { number: 42, title: "Actionable bug report", status: "ready", score: 90, reasons: [], warnings: [] },
          { number: 41, title: "Covered issue", status: "do_not_use", score: 0, reasons: [], warnings: [] },
        ],
        summary: "2 open issues evaluated.",
      },
    });
    expect(decision.issueQuality).toMatchObject({ readyCount: 1, doNotUseCount: 1 });
    expect(decision.priorityScore).toBeGreaterThan(35);
    expect(decision.nextActions[0]).toContain("#42");
    expect(decision.whyThisHelps[0]).toMatch(/ready candidate/);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);

    const splitDecision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/split-issues", 0.02, 0.5, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript", openIssuesCount: 4 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      issueQuality: {
        repoFullName: "owner/split-issues",
        generatedAt: "2026-05-29T00:00:00.000Z",
        lane: { repoFullName: "owner/split-issues", lane: "split", issueDiscoveryShare: 0.5, directPrShare: 0.5, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [{ number: 50, title: "Split-lane ready report", status: "ready", score: 85, reasons: [], warnings: [] }],
        summary: "1 open issue evaluated.",
      },
    });
    expect(splitDecision.nextActions[0]).toContain("#50");
    expect(splitDecision.publicNextActions[0]).toContain("issue-quality ready candidates");
    expect(noStructuralCountLeak(splitDecision.publicNextActions)).toBe(true);

    const blockedQualityDecision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/blocked-issues", 0.02, 1, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      issueQuality: {
        repoFullName: "owner/blocked-issues",
        generatedAt: "2026-05-29T00:00:00.000Z",
        lane: { repoFullName: "owner/blocked-issues", lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [{ number: 41, title: "Covered issue", status: "do_not_use", score: 0, reasons: [], warnings: [] }],
        summary: "1 open issue evaluated.",
      },
    });
    expect(blockedQualityDecision.issueQuality).toMatchObject({ readyCount: 0, doNotUseCount: 1 });
    expect(blockedQualityDecision.priorityScore).toBeLessThan(35);
    expect(blockedQualityDecision.riskReasons).toEqual(expect.arrayContaining([expect.stringContaining("No ready issue-quality candidate")]));

    const emptyQualityDecision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/empty-issues", 0.02, 1, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      issueQuality: {
        repoFullName: "owner/empty-issues",
        generatedAt: "2026-05-29T00:00:00.000Z",
        lane: { repoFullName: "owner/empty-issues", lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [],
        summary: "0 open issues evaluated.",
      },
    });
    expect(emptyQualityDecision.priorityScore).toBe(40);
  });

  it("issues avoid_for_now reasoning with sanitized public copy", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/inactive", 0, 0, {}),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      syncState: undefined,
      languageSet: new Set(),
      labelHistory: new Set(),
    });
    expect(decision.recommendation).toBe("avoid_for_now");
    expect(decision.whyThisHelps[0]).toMatch(/risk-adjusted priority is low/);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("does not leak outside-contributor open-PR counts into maintainer-lane copy", () => {
    const outsideCleanup = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/outside", 0.005, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 8, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1, maintainerLane: false } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    const maintainerOwned = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("jsonbored/owned", 0.005, 0, { bug: 1.1 }, 0.2),
      roleContext: { maintainerLane: true } as any,
      outcome: { openPullRequests: 8, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1, maintainerLane: true } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(outsideCleanup.recommendation).toBe("cleanup_first");
    expect(maintainerOwned.recommendation).toBe("maintainer_lane");
    expect(outsideCleanup.nextActions[0]).toMatch(/8 open PR/);
    expect(maintainerOwned.nextActions.join(" | ")).not.toMatch(/8 open PR/);
    expect(maintainerOwned.whyThisHelps.join(" | ")).not.toMatch(/8 open PR/);
    expect(maintainerOwned.nextActions[0]).toMatch(/repo owner/);
    expect(maintainerOwned.whyThisHelps[0]).toMatch(/Maintainer cut: 0.2/);
    expect(noStructuralCountLeak(maintainerOwned.publicNextActions)).toBe(true);
  });

  it("ranks cleanup-first above pursue when open-PR pressure is the trigger", () => {
    const pressure = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/pressure", 0.005, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 7, mergedPullRequests: 2, closedPullRequestRate: 0.1, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    const pursueRepo = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/clean", 0.005, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 2, closedPullRequestRate: 0.1, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(pressure.recommendation).toBe("cleanup_first");
    expect(pursueRepo.recommendation).toBe("pursue");
    expect(pressure.priorityScore).toBeGreaterThan(pursueRepo.priorityScore);
    expect(pressure.nextActions[0]).toMatch(/7 open PR/);
    expect(noStructuralCountLeak(pressure.publicNextActions)).toBe(true);
  });

  it("surfaces queue-pressure caveats when repo open-PR and open-issue queues are large", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/busy", 0.02, 0.5, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript", openPullRequestsCount: 30, openIssuesCount: 120 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(decision.riskReasons).toEqual(expect.arrayContaining([expect.stringContaining("busy"), expect.stringContaining("large")]));
  });

  it("threads languageSet end-to-end via buildContributorDecisionPack", () => {
    const profile = {
      login: "jsonbored",
      github: { topLanguages: ["TypeScript"] },
      source: {},
      gittensor: null,
      registeredRepoActivity: { reposTouched: ["owner/ts"], dominantLabels: ["bug"] },
      trustSignals: {},
    } as any;
    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "jsonbored",
      profile,
      outcomeHistory: { login: "jsonbored", totals: {}, repoOutcomes: [], successPatterns: [], failurePatterns: [], summary: "" } as any,
      repositories: [repoWithLabels("owner/ts", 0.04, 0, { bug: 1.1 })],
      syncStates: [{ repoFullName: "owner/ts", primaryLanguage: "TypeScript" }] as any,
      syncSegments: [],
      totals: [],
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [],
      contributorIssues: [],
      openPrMonitor: emptyOpenPrMonitor("jsonbored"),
    });
    const tsDecision = pack.repoDecisions.find((d) => d.repoFullName === "owner/ts")!;
    expect(tsDecision.languageMatch).toEqual({ language: "TypeScript", match: true });
    expect(tsDecision.labelFit).toContain("bug");
    expect(tsDecision.nextActions[0]).toMatch(/in TypeScript/);
  });

  it("emits sanitized publicNextActions across every recommendation tier without lane shares or counts", () => {
    const tiers = [
      { name: "cleanup_first", outcome: { openPullRequests: 6, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any, lane: "direct_pr", emission: 0.005, idShare: 0, maintainerLane: false },
      { name: "maintainer_lane", outcome: { openPullRequests: 0, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1, maintainerLane: true } as any, lane: "direct_pr", emission: 0.005, idShare: 0, maintainerLane: true, maintainerCut: 0.25 },
      { name: "pursue", outcome: { openPullRequests: 0, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any, lane: "direct_pr", emission: 0.04, idShare: 0, maintainerLane: false },
      { name: "pursue-split", outcome: { openPullRequests: 0, mergedPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any, lane: "split", emission: 0.04, idShare: 0.5, maintainerLane: false },
      { name: "watch", outcome: undefined, lane: "issue_discovery", emission: 0.01, idShare: 1, maintainerLane: false },
      { name: "avoid_for_now", outcome: undefined, lane: "inactive", emission: 0, idShare: 0, maintainerLane: false },
    ];
    for (const tier of tiers) {
      const decision = __decisionPackInternals.buildRepoDecision({
        repo: repoWithLabels(`owner/${tier.name}`, tier.emission, tier.idShare, { bug: 1.1 }, tier.maintainerCut ?? 0),
        roleContext: { maintainerLane: tier.maintainerLane } as any,
        outcome: tier.outcome,
        syncState: { primaryLanguage: "TypeScript" } as any,
        languageSet: new Set(["typescript"]),
        labelHistory: new Set(["bug"]),
      });
      const joined = decision.publicNextActions.join(" | ");
      expect(decision.publicNextActions.length).toBeGreaterThan(0);
      expect(joined).not.toMatch(/\b\d+(\.\d+)?\b/);
      expect(joined).not.toMatch(/share|emission|priority/i);
      expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
    }
  });

  it("covers languageMatch true/false and labelFit empty/non-empty paths", () => {
    const ctx = (overrides: Record<string, unknown> = {}) =>
      __decisionPackInternals.buildRepoDecision({
        repo: repoWithLabels("owner/lang", 0.005, 0, { bug: 1.1 }),
        roleContext: { maintainerLane: false } as any,
        outcome: { openPullRequests: 0, mergedPullRequests: 1, closedPullRequestRate: 0, credibility: 1 } as any,
        syncState: { primaryLanguage: "TypeScript" } as any,
        languageSet: new Set(["typescript"]),
        labelHistory: new Set(["bug"]),
        ...overrides,
      });
    const matched = ctx();
    expect(matched.languageMatch).toEqual({ language: "TypeScript", match: true });
    expect(matched.labelFit).toEqual(["bug"]);
    expect(matched.nextActions[0]).toMatch(/in TypeScript/);
    expect(matched.nextActions[0]).toMatch(/target labels: bug/);

    const noLangMatch = ctx({ languageSet: new Set(["go"]) });
    expect(noLangMatch.languageMatch).toEqual({ language: "TypeScript", match: false });
    expect(noLangMatch.nextActions[0]).not.toMatch(/in TypeScript/);

    const noSyncLang = ctx({ syncState: undefined });
    expect(noSyncLang.languageMatch).toEqual({ language: null, match: false });
    expect(noSyncLang.nextActions[0]).not.toMatch(/ in [A-Z]/);

    const emptyLabels = ctx({ labelHistory: new Set() });
    expect(emptyLabels.labelFit).toEqual([]);
    expect(emptyLabels.nextActions[0]).not.toMatch(/target labels/);

    const missingHistory = ctx({ labelHistory: undefined });
    expect(missingHistory.labelFit).toEqual([]);
  });

  it("preserves cleanup_first priority when triggered without an open_pr_pressure blocker", () => {
    const moderateCleanup = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/moderate", 0.005, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 3, mergedPullRequests: 1, closedPullRequestRate: 0.1, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(moderateCleanup.recommendation).toBe("cleanup_first");
    expect(moderateCleanup.scoreBlockers.map((b) => b.code)).not.toContain("open_pr_pressure");
    const pursueBaseline = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/baseline", 0.005, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 1, closedPullRequestRate: 0.1, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(pursueBaseline.recommendation).toBe("pursue");
    expect(moderateCleanup.priorityScore).toBeGreaterThan(pursueBaseline.priorityScore);
  });

  it("handles undefined outcome paths in cleanup and watch copy", () => {
    const cleanup = __decisionPackInternals.whyThisHelpsFor("cleanup_first", {
      repoFullName: "owner/x",
      lane: "direct_pr",
      queue: { openPullRequests: 0, openIssues: 0, mergedPullRequests: 0, closedUnmergedPullRequests: 0 },
      rewardUpside: { directPrShare: 0.01, issueDiscoveryShare: 0, emissionShare: 0.01, maintainerCut: 0 },
      outcome: undefined,
      languageMatch: { language: null, match: false },
      labelFit: [],
    } as any);
    expect(cleanup[0]).toMatch(/0 of your open PR/);

    const cleanupNext = __decisionPackInternals.nextActionsFor("cleanup_first", {
      repoFullName: "owner/x",
      lane: "direct_pr",
      queue: { openPullRequests: 0, openIssues: 0, mergedPullRequests: 0, closedUnmergedPullRequests: 0 },
      rewardUpside: { directPrShare: 0.01, issueDiscoveryShare: 0, emissionShare: 0.01, maintainerCut: 0 },
      outcome: undefined,
      languageMatch: { language: null, match: false },
      labelFit: [],
    } as any);
    expect(cleanupNext[0]).toMatch(/your 0 open PR/);

    const watchSplit = __decisionPackInternals.whyThisHelpsFor("watch", {
      repoFullName: "owner/y",
      lane: "split",
      queue: { openPullRequests: 0, openIssues: 0, mergedPullRequests: 0, closedUnmergedPullRequests: 0 },
      rewardUpside: { directPrShare: 0.01, issueDiscoveryShare: 0.01, emissionShare: 0.01, maintainerCut: 0 },
      outcome: undefined,
      languageMatch: { language: null, match: false },
      labelFit: [],
    } as any);
    expect(watchSplit[0]).toMatch(/low-direct-PR/);
  });

  it("covers scoreBlockersFor branches when outcome is undefined", () => {
    const noOutcome = __decisionPackInternals.scoreBlockersFor("owner/x", "direct_pr", { maintainerLane: false } as any, undefined);
    expect(noOutcome.map((b) => b.code)).not.toContain("open_pr_pressure");
    expect(noOutcome.map((b) => b.code)).not.toContain("closed_pr_credibility");
    expect(noOutcome.map((b) => b.code)).not.toContain("low_credibility");
  });

  it("falls back to nowIso in withSnapshotMetadata when both generatedAt fields are missing", () => {
    const wrapped = __decisionPackInternals.withSnapshotMetadata({
      id: "snap",
      signalType: "contributor-decision-pack",
      targetKey: "user",
      generatedAt: null,
      payload: { status: "ready", source: "computed", login: "user", repoDecisions: [], topActions: [] } as any,
    });
    expect(typeof wrapped.generatedAt).toBe("string");
    expect(wrapped.generatedAt.length).toBeGreaterThan(0);
  });

  it("produces fully deterministic repoDecisions, priorityScores, and nextActions across builds", () => {
    const fixedArgs = () => ({
      login: "jsonbored",
      profile: {
        login: "jsonbored",
        github: { topLanguages: ["TypeScript"] },
        source: {},
        gittensor: null,
        registeredRepoActivity: { reposTouched: ["owner/a", "owner/b", "owner/c"], dominantLabels: ["bug"] },
        trustSignals: {},
      } as any,
      outcomeHistory: { login: "jsonbored", totals: {}, repoOutcomes: [], successPatterns: [], failurePatterns: [], summary: "" } as any,
      repositories: [repoWithLabels("owner/c", 0.02, 0, { bug: 1 }), repoWithLabels("owner/a", 0.02, 0, { bug: 1 }), repoWithLabels("owner/b", 0.02, 0, { bug: 1 })],
      syncStates: [{ repoFullName: "owner/a", primaryLanguage: "TypeScript" }, { repoFullName: "owner/b", primaryLanguage: "TypeScript" }, { repoFullName: "owner/c", primaryLanguage: "TypeScript" }] as any,
      syncSegments: [],
      totals: [],
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [],
      contributorIssues: [],
      openPrMonitor: emptyOpenPrMonitor("jsonbored"),
    });
    const packA = __decisionPackInternals.buildContributorDecisionPack(fixedArgs());
    const packB = __decisionPackInternals.buildContributorDecisionPack(fixedArgs());
    expect(packA.repoDecisions.map((d) => d.repoFullName)).toEqual(packB.repoDecisions.map((d) => d.repoFullName));
    expect(packA.repoDecisions.map((d) => d.priorityScore)).toEqual(packB.repoDecisions.map((d) => d.priorityScore));
    expect(packA.repoDecisions.map((d) => d.nextActions)).toEqual(packB.repoDecisions.map((d) => d.nextActions));
    expect(packA.topActions.map((a) => `${a.actionKind}:${a.repoFullName}`)).toEqual(packB.topActions.map((a) => `${a.actionKind}:${a.repoFullName}`));
  });
});

function emptyOpenPrMonitor(login: string) {
  return {
    login,
    generatedAt: "2026-05-25T00:00:00.000Z",
    openPrCount: 0,
    registeredRepoCount: 0,
    cleanupFirst: false,
    summary: "No open PRs on registered repos.",
    guidance: [],
    pendingScenarios: [],
    pullRequests: [],
  };
}

function noStructuralCountLeak(lines: string[]): boolean {
  const joined = lines.join(" | ");
  if (/\b(openPullRequests?|openIssues?|mergedPullRequests?|closedPullRequests?|priorityScore)\b/.test(joined)) return false;
  return !/\b\d+\s*open\s*PR/i.test(joined);
}

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

function repoWithLabels(fullName: string, emissionShare: number, issueDiscoveryShare: number, labelMultipliers: Record<string, number>, maintainerCut = 0) {
  const base = repo(fullName, emissionShare, issueDiscoveryShare);
  return { ...base, registryConfig: { ...base.registryConfig, labelMultipliers, maintainerCut } } as any;
}
