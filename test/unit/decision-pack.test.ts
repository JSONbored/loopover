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

const FORBIDDEN_PUBLIC_TRADEOFF_LANGUAGE =
  /\b(wallet|hotkey|coldkey|raw[-\s]?trust|trust[-\s]?score|reward|reward[-\s]?estimate|payout|farming(?:[-\s]?language)?|private[-\s]?reviewability|private[-\s]?scoreability|scoreability|public[-\s]?score[-\s]?(?:estimate|prediction)|estimated[-\s]?score|score[-\s]?estimate)\b/i;

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
    ).toMatchObject({ recommendation: "watch", queue: { openPullRequests: 1, openIssues: 2, mergedPullRequests: 3 }, rewardUpside: { issueDiscoveryShare: 0.018 } });
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

  it("applies OSS_EMISSION_SHARE to rewardUpside lane shares (not the raw emission share)", () => {
    const outsideRole = { maintainerLane: false } as any;
    // Split repo: emissionShare 0.04, issueDiscoveryShare 0.25. Lane shares are a split of the OSS
    // mining pool (emissionShare * 0.9), matching preview.ts laneMath / reward-risk.ts -- NOT the raw split.
    const split = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/split", 0.04, 0.25),
      roleContext: outsideRole,
      outcome: undefined,
    }).rewardUpside;
    expect(split.emissionShare).toBe(0.04); // raw value preserved (mirrors laneMath.repoEmissionShare)
    expect(split.directPrShare).toBeCloseTo(0.04 * 0.9 * 0.75, 10); // 0.027
    expect(split.issueDiscoveryShare).toBeCloseTo(0.04 * 0.9 * 0.25, 10); // 0.009
    // A single lane share can never exceed the repo's whole OSS mining pool (emissionShare * 0.9).
    expect(split.directPrShare).toBeLessThanOrEqual(0.04 * 0.9 + 1e-9);

    // An explicit snapshot-provided OSS_EMISSION_SHARE override is honored.
    const overridden = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/override", 0.04, 0),
      roleContext: outsideRole,
      outcome: undefined,
      ossEmissionShare: 0.8,
    }).rewardUpside;
    expect(overridden.directPrShare).toBeCloseTo(0.04 * 0.8, 10); // 0.032
  });

  it("clamps out-of-range registry shares so lane shares never go negative (matches preview.ts)", () => {
    const outsideRole = { maintainerLane: false } as any;
    // Registry config is untrusted and unclamped at ingestion. An out-of-range issueDiscoveryShare > 1
    // must clamp to 1 (as preview.ts laneMath does) rather than produce a negative directPrShare.
    const outOfRange = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/out-of-range", 0.01, 1.5),
      roleContext: outsideRole,
      outcome: undefined,
    }).rewardUpside;
    expect(outOfRange.directPrShare).toBe(0); // 0.01 * 0.9 * (1 - clamp(1.5,0,1)) = 0, never negative
    expect(outOfRange.directPrShare).toBeGreaterThanOrEqual(0);
    expect(outOfRange.issueDiscoveryShare).toBeCloseTo(0.01 * 0.9 * 1, 10); // 0.009

    // A negative issueDiscoveryShare clamps to 0, keeping the full slice on the direct-PR lane.
    const negative = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/negative", 0.01, -0.5),
      roleContext: outsideRole,
      outcome: undefined,
    }).rewardUpside;
    expect(negative.issueDiscoveryShare).toBe(0);
    expect(negative.directPrShare).toBeCloseTo(0.01 * 0.9 * 1, 10); // 0.009
  });

  it("keeps repo outcome patterns scoped to the private pattern field", () => {
    const outsideRole = { maintainerLane: false } as any;
    const maintainerRole = { maintainerLane: true } as any;
    const patterns = {
      summary: "owner/direct: 5 merged, 3 closed-unmerged, 0 open (0 stale) PR(s); outside-contributor merge rate 62% across 8 decided PR(s).",
      outsideContributorMergeRate: 0.62,
      sampleSize: 8,
      successPatterns: [{ repoFullName: "owner/direct", title: "Merge-friendly pattern", detail: "PRs touching src/ merge well here (5/5 merged).", confidence: "high" }],
      riskPatterns: [{ repoFullName: "owner/direct", title: "High closure-risk pattern", detail: "PRs with no linked issue have high closure risk here (0/3 merged).", confidence: "medium" }],
    } as any;

    const pursue = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: outsideRole,
      outcome: undefined,
      repoOutcomePatterns: patterns,
    });
    expect(pursue.recommendation).toBe("pursue");
    expect(pursue.repoOutcomePatterns?.sampleSize).toBe(8);
    expect(pursue.repoOutcomePatterns?.successPatterns[0]?.detail).toContain("PRs touching src/ merge well here");
    expect(pursue.repoOutcomePatterns?.riskPatterns[0]?.detail).toContain("high closure risk");
    expect(pursue.whyThisHelps.some((line) => line.includes("PRs touching src/ merge well here"))).toBe(false);
    expect(pursue.riskReasons.some((line) => line.includes("high closure risk"))).toBe(false);

    // Maintainer-lane repos also surface the patterns for private context without folding risk into generic reasons.
    const maintainer = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: maintainerRole,
      outcome: undefined,
      repoOutcomePatterns: patterns,
    });
    expect(maintainer.recommendation).toBe("maintainer_lane");
    expect(maintainer.repoOutcomePatterns?.sampleSize).toBe(8);
    expect(maintainer.riskReasons.some((line) => line.includes("high closure risk"))).toBe(false);
  });

  it("feeds private recommendation outcome feedback without changing public next actions", () => {
    const baseline = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
    });
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      recommendationOutcomeFeedback: {
        repoFullName: "owner/direct",
        total: 4,
        accepted: 1,
        rejected: 0,
        ignored: 1,
        stale: 0,
        merged: 1,
        closed: 1,
        improved: 1,
        positive: 3,
        negative: 1,
        maintainerLaneTotal: 2,
        latestOutcomeAt: "2026-05-30T00:00:00.000Z",
        signal: "positive",
      },
    });

    expect(decision.recommendationOutcomeFeedback).toMatchObject({ signal: "positive", positive: 3, rejected: 0, negative: 1, maintainerLaneTotal: 2 });
    expect(decision.priorityScore).toBeGreaterThan(baseline.priorityScore);
    expect(decision.whyThisHelps.some((line) => line.includes("Private recommendation feedback"))).toBe(true);
    expect(decision.riskReasons.some((line) => line.includes("Private recommendation feedback"))).toBe(true);
    expect(decision.publicNextActions.join(" ")).not.toMatch(/Private recommendation feedback|wallet|hotkey|raw trust score|reward estimate|payout|farming/i);
  });

  it("penalizes negative and mixed private recommendation feedback without leaking it publicly", () => {
    const baseline = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
    });
    const negative = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      recommendationOutcomeFeedback: {
        repoFullName: "owner/direct",
        total: 6,
        accepted: 0,
        rejected: 2,
        ignored: 2,
        stale: 1,
        merged: 0,
        closed: 1,
        improved: 0,
        positive: 0,
        negative: 6,
        maintainerLaneTotal: 0,
        latestOutcomeAt: "2026-05-30T00:00:00.000Z",
        signal: "negative",
      },
    });
    const mixed = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      recommendationOutcomeFeedback: {
        repoFullName: "owner/direct",
        total: 4,
        accepted: 1,
        rejected: 0,
        ignored: 1,
        stale: 0,
        merged: 1,
        closed: 1,
        improved: 0,
        positive: 2,
        negative: 2,
        maintainerLaneTotal: 1,
        latestOutcomeAt: null,
        signal: "mixed",
      },
    });

    expect(negative.priorityScore).toBeLessThan(baseline.priorityScore);
    expect(negative.recommendationOutcomeFeedback).toMatchObject({ negative: 6, rejected: 2, closed: 1, stale: 1, ignored: 2 });
    expect(negative.riskReasons.join(" ")).toMatch(/6 unresolved or negative/);
    expect(negative.riskReasons.join(" ")).toContain("2 rejected, 1 closed, 1 stale, 2 ignored");
    expect(negative.whyThisHelps.some((line) => line.includes("Private recommendation feedback"))).toBe(false);
    expect(mixed.priorityScore).toBeLessThan(baseline.priorityScore);
    expect(mixed.riskReasons.join(" ")).toMatch(/2 unresolved or negative/);
    expect(mixed.whyThisHelps.join(" ")).toMatch(/2 positive/);
    expect(`${negative.publicNextActions.join(" ")} ${mixed.publicNextActions.join(" ")}`).not.toMatch(/Private recommendation feedback/i);
  });

  it("keeps zero-count and maintainer-lane private feedback from changing repo decisions", () => {
    const baseline = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
    });
    const zero = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: false } as any,
      outcome: undefined,
      recommendationOutcomeFeedback: {
        repoFullName: "owner/direct",
        total: 0,
        accepted: 0,
        rejected: 0,
        ignored: 0,
        stale: 0,
        merged: 0,
        closed: 0,
        improved: 0,
        positive: 0,
        negative: 0,
        maintainerLaneTotal: 3,
        latestOutcomeAt: null,
        signal: "neutral",
      },
    });
    const maintainerLane = __decisionPackInternals.buildRepoDecision({
      repo: repo("owner/direct", 0.03, 0),
      roleContext: { maintainerLane: true } as any,
      outcome: undefined,
      recommendationOutcomeFeedback: {
        repoFullName: "owner/direct",
        total: 2,
        accepted: 0,
        rejected: 0,
        ignored: 1,
        stale: 0,
        merged: 0,
        closed: 1,
        improved: 0,
        positive: 0,
        negative: 2,
        maintainerLaneTotal: 0,
        latestOutcomeAt: null,
        signal: "negative",
      },
    });

    expect(zero.recommendationOutcomeFeedback).toBeUndefined();
    expect(zero.priorityScore).toBe(baseline.priorityScore);
    expect(maintainerLane.recommendation).toBe("maintainer_lane");
    expect(maintainerLane.riskReasons.join(" ")).not.toMatch(/Private recommendation feedback/);
  });

  it("summarizes non-empty recommendation feedback in contributor decision packs", () => {
    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "dev",
      profile: {
        login: "dev",
        github: {},
        source: {},
        gittensor: null,
        registeredRepoActivity: {},
        trustSignals: {},
      } as any,
      outcomeHistory: { login: "dev", totals: {}, repoOutcomes: [], successPatterns: [], failurePatterns: [], summary: "" } as any,
      repositories: [],
      syncStates: [],
      syncSegments: [],
      totals: [],
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [],
      contributorIssues: [],
      openPrMonitor: emptyOpenPrMonitor("dev"),
      recommendationOutcomeFeedback: {
        login: "dev",
        generatedAt: "2026-05-30T00:00:00.000Z",
        windowDays: 90,
        totals: {
          total: 1,
          accepted: 1,
          rejected: 0,
          ignored: 0,
          stale: 0,
          merged: 0,
          closed: 0,
          improved: 0,
          positive: 1,
          negative: 0,
          maintainerLaneTotal: 1,
        },
        sources: { explicit: 1, inferred: 0 },
        states: [{ state: "accepted", count: 1 }],
        repos: [],
        maintainerLane: { total: 1, states: [{ state: "merged", count: 1 }] },
        privateSummary: "dev has feedback.",
      },
    });

    expect(pack.summary).toContain("Recommendation feedback: 1 positive, 0 negative, 1 maintainer-lane separated.");
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
      opportunities: [],
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
    expect(loaded?.recommendationOutcomeFeedback).toMatchObject({ login: "jsonbored", totals: { total: 0, maintainerLaneTotal: 0 } });
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
      opportunities: [
        {
          repoFullName: "owner/pursue",
          issueNumber: 7,
          title: "Fresh funded task",
          fit: "good",
          score: 82,
          lane: "split",
          multiplierTier: "community",
          availability: "ready",
          reasons: ["Active bounty context is available."],
          warnings: [],
        },
      ],
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
    expect(pack.actionPortfolio.bucketOrder).toEqual(["cleanup", "wait", "direct_pr", "issue_discovery", "avoid", "maintainer_lane"]);
    const portfolioBuckets = new Map(pack.actionPortfolio.buckets.map((bucket) => [bucket.bucket, bucket.actions]));
    expect(portfolioBuckets.get("cleanup")).toEqual([expect.objectContaining({ repoFullName: "owner/cleanup", actionKind: "cleanup_existing_prs" })]);
    expect(portfolioBuckets.get("wait")).toEqual([expect.objectContaining({ repoFullName: "owner/cleanup", actionKind: "land_existing_prs", status: "watch" })]);
    expect(portfolioBuckets.get("direct_pr")).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/pursue", actionKind: "open_new_direct_pr" })]));
    expect(portfolioBuckets.get("issue_discovery")).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/issues", actionKind: "file_issue_discovery" })]));
    expect(portfolioBuckets.get("avoid")).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "owner/inactive", recommendation: "avoid_for_now" })]));
    expect(portfolioBuckets.get("maintainer_lane")).toEqual(expect.arrayContaining([expect.objectContaining({ repoFullName: "jsonbored/owned", actionKind: "maintainer_lane_improve_repo" })]));
    expect(pack.actionPortfolio.topActions[0]).toMatchObject({ bucket: "cleanup", repoFullName: "owner/cleanup" });
    expect(portfolioBuckets.get("issue_discovery")?.[0]?.scoreabilityImpact).toMatch(/Direct PR scoreability is not the target/);
    expect(JSON.stringify(pack.actionPortfolio.buckets.map((bucket) => bucket.actions.map((entry) => entry.publicSafeSummary)))).not.toMatch(
      /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate|scoreability/i,
    );
    expect(pack.roleContexts.map((role) => role.repoFullName)).not.toContain("owner/unconfigured");
    expect(pack.opportunities).toEqual([expect.objectContaining({ repoFullName: "owner/pursue", issueNumber: 7, fit: "good" })]);
    expect(pack.nextActions.length).toBeGreaterThan(0);
    expect(pack.evidenceGraph).toMatchObject({ login: "jsonbored", totals: expect.objectContaining({ repositories: expect.any(Number) }) });
  });

  it("merges open PR monitor guidance into pack summary and next actions", () => {
    const monitor = {
      login: "jsonbored",
      generatedAt: "2026-05-25T00:00:00.000Z",
      openPrCount: 1,
      registeredRepoCount: 1,
      cleanupFirst: true,
      summary: "One open PR needs attention on owner/cleanup.",
      guidance: ["Close or land owner/cleanup#42 before opening new direct PR work."],
      pendingScenarios: [
        {
          repoFullName: "owner/cleanup",
          detection: {
            source: "github_observed" as const,
            pendingMergedPrCount: 1,
            pendingClosedPrCount: 0,
            approvedPrCount: 1,
            expectedOpenPrCountAfterMerge: 5,
            scenarioNotes: ["1 open PR looks merge-ready after review.", "Expected open PR pressure drops after merge."],
            classified: [],
          },
        },
      ],
      pullRequests: [
        {
          repoFullName: "owner/cleanup",
          number: 42,
          title: "WIP cleanup",
          classification: "needs_author" as const,
          summary: "Changes requested.",
          reasons: ["Reviewer asked for tests."],
          nextSteps: ["Add tests and push updates."],
        },
      ],
    };
    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "jsonbored",
      profile: {
        login: "jsonbored",
        generatedAt: "2026-05-25T00:00:00.000Z",
        github: {},
        source: {},
        gittensor: null,
        registeredRepoActivity: { reposTouched: ["owner/cleanup"] },
        trustSignals: {},
      } as any,
      outcomeHistory: {
        login: "jsonbored",
        generatedAt: "2026-05-25T00:00:00.000Z",
        source: {},
        totals: {},
        repoOutcomes: [
          { repoFullName: "owner/cleanup", role: "outside_contributor", lane: "direct_pr", maintainerLane: false, openPullRequests: 6, closedPullRequestRate: 0.4, credibility: 0.5, mergedPullRequests: 1, closedPullRequests: 2, validSolvedIssues: 0 },
        ],
        successPatterns: [],
        failurePatterns: [],
        summary: "fixture",
      } as any,
      repositories: [repo("owner/cleanup", 0.03, 0)],
      syncStates: [
        { repoFullName: "owner/cleanup", status: "complete", openPullRequestsCount: 30, openIssuesCount: 150, recentMergedPullRequestsCount: 5, warnings: [], lastCompletedAt: "2026-05-25T00:00:00.000Z" },
      ] as any,
      syncSegments: [],
      totals: [],
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [{ repoFullName: "owner/cleanup", authorLogin: "jsonbored", authorAssociation: "CONTRIBUTOR" }] as any,
      contributorIssues: [],
      openPrMonitor: monitor,
    });
    expect(pack.summary).toContain("One open PR needs attention");
    expect(pack.nextActions[0]).toMatch(/owner\/cleanup#42/);
    expect(pack.openPrMonitor).toEqual(monitor);
    const cleanupPortfolioItem = pack.actionPortfolio.buckets.find((bucket) => bucket.bucket === "cleanup")?.actions[0];
    expect(cleanupPortfolioItem).toMatchObject({
      repoFullName: "owner/cleanup",
      scenarioProjection: { source: "github_observed", pendingMergedPrCount: 1, expectedOpenPrCountAfterMerge: 5 },
    });
    expect(cleanupPortfolioItem?.whyNow.join(" ")).toMatch(/Scenario projection/);
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
    // 38, not 40: upside = issueDiscoveryShare (0.02 * OSS_EMISSION_SHARE 0.9 = 0.018) * 1000 = 18.
    expect(emptyQualityDecision.priorityScore).toBe(38);
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

  it("separates direct-PR, issue-discovery, burden, queue, and policy tradeoff dimensions", async () => {
    const { parseFocusManifest } = await import("../../src/signals/focus-manifest");
    const direct = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/direct-fit", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 2, closedPullRequestRate: 0, credibility: 1 } as any,
      totals: { openPullRequestsTotal: 1, openIssuesTotal: 8, mergedPullRequestsTotal: 4, closedUnmergedPullRequestsTotal: 0 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(direct.tradeoffSummary).toMatchObject({
      directPrFit: { level: "strong" },
      issueDiscoveryFit: { level: "weak" },
      maintainerBurden: { level: "low" },
      queuePressure: { level: "low" },
      policyConfidence: { level: "medium" },
    });
    expect(direct.tradeoffSummary?.publicSummary).toMatch(/direct PR work is the clearest path/i);

    const issueOnly = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/issue-fit", 0.03, 1, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      issueQuality: {
        repoFullName: "owner/issue-fit",
        generatedAt: "2026-06-02T00:00:00.000Z",
        lane: { repoFullName: "owner/issue-fit", lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [{ number: 7, title: "Ready duplicate-safe issue", status: "ready", score: 88, reasons: [], warnings: [] }],
        summary: "1 issue evaluated.",
      },
    });
    expect(issueOnly.tradeoffSummary).toMatchObject({
      directPrFit: { level: "blocked" },
      issueDiscoveryFit: { level: "strong" },
    });
    expect(issueOnly.tradeoffSummary?.publicSummary).toMatch(/issue discovery is the clearest path/i);

    const splitBusy = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/split-busy", 0.03, 0.5, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 1, closedPullRequestRate: 0, credibility: 1 } as any,
      totals: { openPullRequestsTotal: 12, openIssuesTotal: 120, mergedPullRequestsTotal: 4, closedUnmergedPullRequestsTotal: 0 } as any,
      focusManifest: parseFocusManifest({ source: "repo_file", issueDiscoveryPolicy: "encouraged" }),
      issueQuality: {
        repoFullName: "owner/split-busy",
        generatedAt: "2026-06-02T00:00:00.000Z",
        lane: { repoFullName: "owner/split-busy", lane: "split", issueDiscoveryShare: 0.5, directPrShare: 0.5, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [{ number: 8, title: "Ready split issue", status: "ready", score: 90, reasons: [], warnings: [] }],
        summary: "1 issue evaluated.",
      },
    });
    expect(splitBusy.tradeoffSummary).toMatchObject({
      directPrFit: { level: "moderate" },
      issueDiscoveryFit: { level: "strong" },
      maintainerBurden: { level: "high" },
      queuePressure: { level: "high" },
      policyConfidence: { level: "high" },
    });

    const policyConflict = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/policy-conflict", 0.03, 0.5, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      focusManifest: parseFocusManifest({ source: "repo_file", issueDiscoveryPolicy: "discouraged" }),
    });
    expect(policyConflict.tradeoffSummary).toMatchObject({
      issueDiscoveryFit: { level: "weak" },
      policyConfidence: { level: "low" },
    });

    const serialized = JSON.stringify([direct.tradeoffSummary, issueOnly.tradeoffSummary, splitBusy.tradeoffSummary, policyConflict.tradeoffSummary]);
    expect(serialized).not.toMatch(FORBIDDEN_PUBLIC_TRADEOFF_LANGUAGE);
    expect(
      __decisionPackInternals.sanitizeTradeoffPublicText(
        "wallet hotkey reward-estimate payout scoreability public-score-prediction trust-score private-reviewability private-scoreability farming-language",
      ),
    ).not.toMatch(FORBIDDEN_PUBLIC_TRADEOFF_LANGUAGE);
  });

  it("adds deterministic counterfactual reasons for wait, cleanup-first, and choose-another-issue alternatives", () => {
    const pursue = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/direct-counterfactual", 0.04, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 2, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript", openPullRequestsCount: 1, openIssuesCount: 6 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(pursue.recommendation).toBe("pursue");
    expect(pursue.counterfactualReasons?.map((reason) => reason.alternative)).toEqual(
      expect.arrayContaining(["wait", "cleanup_first", "choose_another_issue"]),
    );
    expect(pursue.counterfactualReasons?.find((reason) => reason.alternative === "wait")).toMatchObject({
      rank: expect.any(Number),
      facts: expect.arrayContaining([expect.stringContaining("current recommendation is pursue")]),
      assumptions: expect.arrayContaining([expect.stringContaining("No issue-quality cache")]),
    });

    const cleanupFirst = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/cleanup-counterfactual", 0.04, 0, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 7, mergedPullRequests: 1, closedPullRequestRate: 0.1, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript", openPullRequestsCount: 8, openIssuesCount: 4 } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(cleanupFirst.recommendation).toBe("cleanup_first");
    expect(cleanupFirst.counterfactualReasons?.map((reason) => reason.alternative)).toEqual(
      expect.arrayContaining(["wait", "choose_another_issue", "replace"]),
    );
    expect(cleanupFirst.counterfactualReasons?.map((reason) => reason.alternative)).not.toContain("cleanup_first");

    const issueDiscovery = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/issue-counterfactual", 0.02, 1, { bug: 1.1 }),
      roleContext: { maintainerLane: false } as any,
      issueQuality: {
        repoFullName: "owner/issue-counterfactual",
        generatedAt: "2026-06-02T00:00:00.000Z",
        lane: { repoFullName: "owner/issue-counterfactual", lane: "issue_discovery", issueDiscoveryShare: 1, directPrShare: 0, summary: "", contributorGuidance: "", maintainerGuidance: "" },
        issues: [
          { number: 11, title: "Ready issue", status: "ready", score: 90, reasons: [], warnings: [] },
          { number: 12, title: "Covered issue", status: "do_not_use", score: 0, reasons: [], warnings: [] },
        ],
        summary: "2 open issues evaluated.",
      },
    });
    const chooseAnother = issueDiscovery.counterfactualReasons?.find((reason) => reason.alternative === "choose_another_issue");
    expect(issueDiscovery.recommendation).toBe("watch");
    expect(chooseAnother?.facts.join(" ")).toMatch(/issue-quality cache has 1 ready candidate/);

    const summaries = [pursue, cleanupFirst, issueDiscovery].flatMap((decision) => decision.counterfactualReasons?.map((reason) => reason.publicSummary) ?? []);
    expect(summaries.join(" ")).not.toMatch(FORBIDDEN_PUBLIC_TRADEOFF_LANGUAGE);
  });

  it("sanitizes counterfactual public summaries", () => {
    expect(
      __decisionPackInternals.sanitizeCounterfactualPublicText(
        "wallet hotkey reward-estimate payout scoreability public-score-prediction trust-score private-reviewability private-scoreability farming-language",
      ),
    ).not.toMatch(FORBIDDEN_PUBLIC_TRADEOFF_LANGUAGE);
  });

  it("matches label history against config labels case-insensitively (regression)", () => {
    // A mixed-case dominant label must overlap a differently-cased config label, mirroring the opportunity
    // engine and this file's own case-insensitive languageSet. Covers both the built Set and the lookup.
    const profile = {
      login: "jsonbored",
      github: { topLanguages: [] },
      source: {},
      gittensor: null,
      registeredRepoActivity: { reposTouched: ["owner/gfi"], dominantLabels: ["Good First Issue"] },
      trustSignals: {},
    } as any;
    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "jsonbored",
      profile,
      outcomeHistory: { login: "jsonbored", totals: {}, repoOutcomes: [], successPatterns: [], failurePatterns: [], summary: "" } as any,
      repositories: [repoWithLabels("owner/gfi", 0.04, 0, { "good first issue": 1.5 })],
      syncStates: [],
      syncSegments: [],
      totals: [],
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [],
      contributorIssues: [],
      openPrMonitor: emptyOpenPrMonitor("jsonbored"),
    });
    const decision = pack.repoDecisions.find((d) => d.repoFullName === "owner/gfi")!;
    expect(decision.labelFit).toEqual(["good first issue"]);

    // Direct lookup-side check: a mixed-case config key overlaps a lowercased history entry.
    const repoDecision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/lang", 0.005, 0, { "Good First Issue": 1.5 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { openPullRequests: 0, mergedPullRequests: 1, closedPullRequestRate: 0, credibility: 1 } as any,
      labelHistory: new Set(["good first issue"]),
    } as any);
    expect(repoDecision.labelFit).toEqual(["Good First Issue"]);
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
      payload: { status: "ready", source: "computed", login: "user", repoDecisions: undefined, topActions: undefined } as any,
    });
    expect(typeof wrapped.generatedAt).toBe("string");
    expect(wrapped.generatedAt.length).toBeGreaterThan(0);
    expect(wrapped.actionPortfolio.topActions).toEqual([]);
  });

  it("builds action portfolios from sparse legacy actions with stable tie-breaks", () => {
    const directDecision = (repoFullName: string): RepoDecision =>
      ({
        repoFullName,
        recommendation: "pursue",
        priorityScore: 30,
        lane: { lane: "direct_pr" },
        whyThisHelps: [],
        riskReasons: [],
        nextActions: ["Open a narrow PR."],
        publicNextActions: ["Run public preflight before posting."],
        scoreBlockers: [],
        rewardUpside: { directPrShare: 0.03, issueDiscoveryShare: 0, emissionShare: 0.02 },
      }) as any;
    const maintainerDecision = {
      ...directDecision("owner/maintainer"),
      recommendation: "maintainer_lane",
      priorityScore: 20,
      scoreBlockers: [{ code: "maintainer_lane", severity: "info" }],
    } as RepoDecision;
    const portfolio = __decisionPackInternals.buildActionPortfolio({
      generatedAt: "2026-05-25T00:00:00.000Z",
      repoDecisions: [
        directDecision("owner/beta"),
        directDecision("owner/alpha"),
        maintainerDecision,
        { recommendation: "pursue", priorityScore: 5 } as RepoDecision,
      ],
      topActions: [
        { actionKind: "open_new_direct_pr", repoFullName: "owner/beta", priorityScore: 30, recommendation: "pursue", whyThisHelps: [], nextActions: [], publicNextActions: [] },
        { actionKind: "open_new_direct_pr", repoFullName: "owner/alpha", priorityScore: 30, recommendation: "pursue", whyThisHelps: [], nextActions: [], publicNextActions: [] },
        { actionKind: "maintainer_lane_improve_repo", repoFullName: "owner/maintainer", priorityScore: 20, recommendation: "maintainer_lane", whyThisHelps: [], nextActions: [], publicNextActions: ["Avoid reward payout language."] },
        { actionKind: "maintainer_cut_readiness", repoFullName: "owner/maintainer", priorityScore: 20, recommendation: "maintainer_lane", whyThisHelps: [], nextActions: [], publicNextActions: ["Prepare public intake notes."] },
        { actionKind: "maintainer_cut_readiness", repoFullName: "owner/maintainer", priorityScore: 20, recommendation: "maintainer_lane", whyThisHelps: [], nextActions: [], publicNextActions: ["Prepare public intake notes."] },
        { actionKind: "open_new_direct_pr", repoFullName: 42, priorityScore: 99, recommendation: "pursue", whyThisHelps: [], nextActions: [], publicNextActions: [] },
      ] as any,
      openPrMonitor: {
        pendingScenarios: [
          {
            repoFullName: "owner/maintainer",
            detection: {
              source: "user_supplied",
              pendingMergedPrCount: 0,
              pendingClosedPrCount: 1,
              approvedPrCount: 0,
              scenarioNotes: ["Manual projection expects one PR to close."],
              classified: [],
            },
          },
        ],
      } as any,
    });
    const buckets = new Map(portfolio.buckets.map((bucket) => [bucket.bucket, bucket.actions]));
    expect(buckets.get("direct_pr")?.map((action) => action.repoFullName)).toEqual(["owner/alpha", "owner/beta"]);
    expect(buckets.get("maintainer_lane")?.map((action) => action.actionKind)).toEqual(["maintainer_cut_readiness", "maintainer_lane_improve_repo"]);
    expect(buckets.get("maintainer_lane")).toHaveLength(2);
    expect(buckets.get("maintainer_lane")?.[0]?.scenarioProjection).toMatchObject({ source: "user_supplied", pendingClosedPrCount: 1 });
    expect(buckets.get("maintainer_lane")?.[1]?.maintainerImpact).toMatch(/Repo-owner work/);
    expect(JSON.stringify(buckets.get("maintainer_lane"))).not.toMatch(/reward payout/i);
  });

  it("builds safe portfolio fallbacks for empty and sparse action inputs", () => {
    const emptyPortfolio = __decisionPackInternals.buildActionPortfolio({
      generatedAt: "2026-05-25T00:00:00.000Z",
      repoDecisions: [{ priorityScore: 99 } as RepoDecision],
      topActions: [{ actionKind: "open_new_direct_pr", repoFullName: "owner/missing", priorityScore: 99, recommendation: "pursue" } as any],
    });
    expect(emptyPortfolio.summary).toBe("No portfolio actions are currently available from the decision pack.");
    expect(emptyPortfolio.topActions).toEqual([]);
    expect(emptyPortfolio.buckets.every((bucket) => bucket.actions.length === 0)).toBe(true);
    expect(emptyPortfolio.buckets.find((bucket) => bucket.bucket === "direct_pr")?.summary).toBe("No direct pr opportunities actions are currently recommended.");

    const sparseDecision = {
      repoFullName: "owner/sparse",
      recommendation: "pursue",
      priorityScore: 17,
      lane: { lane: "direct_pr" },
      whyThisHelps: ["Decision-level reason."],
      riskReasons: ["Queue is busy."],
      nextActions: ["Use decision next action."],
      publicNextActions: ["Use public preflight."],
      scoreBlockers: [{ code: "open_pr_pressure", severity: "warning" }],
      rewardUpside: { directPrShare: 0.02, issueDiscoveryShare: 0, emissionShare: 0.02 },
    } as RepoDecision;

    const portfolio = __decisionPackInternals.buildActionPortfolio({
      generatedAt: "2026-05-25T00:00:00.000Z",
      repoDecisions: [sparseDecision],
      topActions: [
        {
          actionKind: "open_new_direct_pr",
          repoFullName: "owner/sparse",
          priorityScore: Number.NaN,
          recommendation: "pursue",
          whyThisHelps: undefined,
          nextActions: undefined,
          publicNextActions: undefined,
        } as any,
      ],
    });

    const action = portfolio.buckets.find((bucket) => bucket.bucket === "direct_pr")?.actions[0];
    expect(action).toMatchObject({
      repoFullName: "owner/sparse",
      priorityScore: 17,
      whyNow: ["Queue is busy."],
      riskImpact: "Queue is busy.",
      blockedBy: ["open_pr_pressure"],
      rerunWhen: "Rerun after the listed scoreability blockers change.",
      nextActions: ["Use decision next action."],
      publicNextActions: ["Use public preflight."],
    });
    expect(action?.scoreabilityImpact).toMatch(/Blocked by open_pr_pressure/);
    expect(action?.publicSafeSummary).toBe("Use public preflight.");
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
    expect(packA.actionPortfolio.buckets.map((bucket) => `${bucket.bucket}:${bucket.actions.map((action) => `${action.actionKind ?? action.recommendation}:${action.repoFullName}`).join(",")}`)).toEqual(
      packB.actionPortfolio.buckets.map((bucket) => `${bucket.bucket}:${bucket.actions.map((action) => `${action.actionKind ?? action.recommendation}:${action.repoFullName}`).join(",")}`),
    );
    expect(packA.evidenceGraph?.repos.map((repo) => repo.repoFullName)).toEqual(packB.evidenceGraph?.repos.map((repo) => repo.repoFullName));
  });

  it("threads a maintainer focus manifest into RepoDecision without leaking maintainer-private notes", async () => {
    const { parseFocusManifest } = await import("../../src/signals/focus-manifest");
    const manifest = parseFocusManifest({
      source: "repo_file",
      wantedPaths: ["src/"],
      blockedPaths: ["migrations/"],
      preferredLabels: ["bug"],
      linkedIssuePolicy: "required",
      issueDiscoveryPolicy: "discouraged",
      maintainerNotes: ["Internal: ping @owner before touching the queue processor."],
      publicNotes: ["Prefer small, focused PRs."],
    });
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/manifested", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      focusManifest: manifest,
    });
    expect(decision.manifestSummary).toMatchObject({
      present: true,
      source: "repo_file",
      linkedIssuePolicy: "required",
      issueDiscoveryPolicy: "discouraged",
      wantedPathCount: 1,
      blockedPathCount: 1,
      preferredLabels: ["bug"],
      publicNotes: ["Prefer small, focused PRs."],
    });
    expect(decision.riskReasons.join(" ")).toMatch(/maintainer focus manifest blocks/i);
    expect(decision.whyThisHelps.join(" ")).toMatch(/wanted path/i);
    expect(decision.publicNextActions.join(" ")).toMatch(/maintainer requires linked issues/i);
    expect(decision.publicNextActions.join(" ")).toMatch(/Prefer small, focused PRs/);
    // Privacy boundary: maintainer-private notes must not appear anywhere on RepoDecision.
    const decisionJson = JSON.stringify(decision);
    expect(decisionJson).not.toMatch(/ping @owner/);
    expect(decisionJson).not.toMatch(/Internal:/);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("covers the preferred linked-issue and encouraged issue-discovery manifest arms", async () => {
    const { parseFocusManifest } = await import("../../src/signals/focus-manifest");
    const manifest = parseFocusManifest({
      source: "api_record",
      wantedPaths: ["src/"],
      preferredLabels: ["bug"],
      linkedIssuePolicy: "preferred",
      issueDiscoveryPolicy: "encouraged",
    });
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/preferred", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      focusManifest: manifest,
    });
    expect(decision.manifestSummary?.linkedIssuePolicy).toBe("preferred");
    expect(decision.publicNextActions.join(" ")).toMatch(/prefers linked issues/i);
    expect(decision.publicNextActions.join(" ")).toMatch(/issue-discovery reports are welcomed/i);
    expect(decision.publicNextActions.join(" ")).toMatch(/maintainer-preferred label/i);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("covers the optional linked-issue, neutral issue-discovery, and unlabeled manifest arms", async () => {
    const { parseFocusManifest } = await import("../../src/signals/focus-manifest");
    const manifest = parseFocusManifest({
      source: "api_record",
      blockedPaths: ["migrations/"],
      linkedIssuePolicy: "optional",
      issueDiscoveryPolicy: "neutral",
    });
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/neutral", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      focusManifest: manifest,
    });
    expect(decision.manifestSummary?.linkedIssuePolicy).toBe("optional");
    expect(decision.manifestSummary?.issueDiscoveryPolicy).toBe("neutral");
    // Optional/neutral policies and absent preferred labels emit no policy-specific public actions.
    expect(decision.publicNextActions.join(" ")).not.toMatch(/requires linked issues|prefers linked issues/i);
    expect(decision.publicNextActions.join(" ")).not.toMatch(/issue-discovery reports are welcomed|Prefer direct fixes over new issue-discovery/i);
    expect(decision.publicNextActions.join(" ")).not.toMatch(/maintainer-preferred label/i);
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("drops a non-public-safe manifest note before it reaches public next actions", () => {
    // Defense-in-depth: even if a present manifest carries an unsafe public note, the
    // per-note redaction guard keeps it out of the contributor-facing actions.
    const manifest = {
      present: true,
      source: "repo_file",
      wantedPaths: ["src/"],
      blockedPaths: [],
      preferredLabels: [],
      linkedIssuePolicy: "optional",
      testExpectations: [],
      issueDiscoveryPolicy: "neutral",
      maintainerNotes: [],
      publicNotes: ["Maximize your reward payout", "Keep PRs small"],
      warnings: [],
    } as const;
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/unsafe-note", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
      focusManifest: manifest as any,
    });
    expect(decision.publicNextActions.join(" ")).not.toMatch(/reward payout/i);
    expect(decision.publicNextActions).toContain("Keep PRs small");
    expect(noStructuralCountLeak(decision.publicNextActions)).toBe(true);
  });

  it("omits manifestSummary when no manifest is configured", () => {
    const decision = __decisionPackInternals.buildRepoDecision({
      repo: repoWithLabels("owner/no-manifest", 0.04, 0, { bug: 1 }),
      roleContext: { maintainerLane: false } as any,
      outcome: { mergedPullRequests: 1, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1 } as any,
      syncState: { primaryLanguage: "TypeScript" } as any,
      languageSet: new Set(["typescript"]),
      labelHistory: new Set(["bug"]),
    });
    expect(decision.manifestSummary).toBeUndefined();
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
