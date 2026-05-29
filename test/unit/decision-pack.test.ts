import { describe, expect, it } from "vitest";
import { persistSignalSnapshot } from "../../src/db/repositories";
import {
  __decisionPackInternals,
  loadContributorDecisionPack,
  loadFreshContributorDecisionPack,
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
    expect(loaded).toMatchObject({ source: "snapshot", snapshotAgeSeconds: expect.any(Number), stale: expect.any(Boolean) });
    expect(repoDecisionFromPack(loaded!, "jsonbored/AWESOME-CLAUDE")).toMatchObject({ recommendation: "maintainer_lane" });
    expect(repoDecisionFromPack(loaded!, "missing/repo")).toBeNull();
    await expect(loadFreshContributorDecisionPack(env, "jsonbored", 1)).resolves.toBeNull();
    await expect(loadFreshContributorDecisionPack(env, "missing", 1)).resolves.toBeNull();

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
    });
    const tsDecision = pack.repoDecisions.find((d) => d.repoFullName === "owner/ts")!;
    expect(tsDecision.languageMatch).toEqual({ language: "TypeScript", match: true });
    expect(tsDecision.labelFit).toContain("bug");
    expect(tsDecision.nextActions[0]).toMatch(/in TypeScript/);
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
    });
    const packA = __decisionPackInternals.buildContributorDecisionPack(fixedArgs());
    const packB = __decisionPackInternals.buildContributorDecisionPack(fixedArgs());
    expect(packA.repoDecisions.map((d) => d.repoFullName)).toEqual(packB.repoDecisions.map((d) => d.repoFullName));
    expect(packA.repoDecisions.map((d) => d.priorityScore)).toEqual(packB.repoDecisions.map((d) => d.priorityScore));
    expect(packA.repoDecisions.map((d) => d.nextActions)).toEqual(packB.repoDecisions.map((d) => d.nextActions));
    expect(packA.topActions.map((a) => `${a.actionKind}:${a.repoFullName}`)).toEqual(packB.topActions.map((a) => `${a.actionKind}:${a.repoFullName}`));
  });
});

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
