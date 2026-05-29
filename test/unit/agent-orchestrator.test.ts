import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRun, persistScoringModelSnapshot, persistSignalSnapshot, upsertIssueFromGitHub, upsertPullRequestFromGitHub, upsertRecentMergedPullRequest, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import {
  __agentOrchestratorInternals,
  executeAgentRun,
  explainBlockersWithAgent,
  getAgentRunBundle,
  planNextWork,
  preflightBranchWithAgent,
  preparePrPacketWithAgent,
  startAgentRun,
  type AgentRunBundle,
} from "../../src/services/agent-orchestrator";
import { CONTRIBUTOR_DECISION_PACK_SIGNAL, type ContributorDecisionPack } from "../../src/services/decision-pack";
import { normalizeRegistryPayload } from "../../src/registry/normalize";
import { persistRegistrySnapshot } from "../../src/registry/sync";
import type { AgentRunRecord, JsonValue } from "../../src/types";
import { nowIso } from "../../src/utils/json";
import { createTestEnv } from "../helpers/d1";

describe("agent orchestrator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queues copilot runs and reports missing decision-pack snapshots without recomputing broad data", async () => {
    const sent: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          sent.push(message);
        },
      } as unknown as Queue,
    });

    const queued = await startAgentRun(env, {
      actorLogin: "oktofeesh1",
      objective: "Find my next Gittensor action",
      surface: "mcp",
      target: { repoFullName: "we-promise/sure" },
    });
    expect(queued.run).toMatchObject({ actorLogin: "oktofeesh1", mode: "copilot", status: "queued" });
    expect(sent).toContainEqual(expect.objectContaining({ type: "run-agent", requestedBy: "mcp", runId: queued.run.id }));

    const missing = await planNextWork(env, { login: "oktofeesh1", surface: "mcp" });
    expect(missing.run.status).toBe("needs_snapshot_refresh");
    expect(missing.summary).toContain("needs a contributor decision-pack refresh");
    expect(sent).toContainEqual({ type: "build-contributor-decision-packs", requestedBy: "api", login: "oktofeesh1" });

    await expect(getAgentRunBundle(env, "missing-run")).resolves.toBeNull();
  });

  it("defaults API runs and fails missing or interrupted runs predictably", async () => {
    const sent: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          sent.push(message);
        },
      } as unknown as Queue,
    });

    const queued = await startAgentRun(env, {
      actorLogin: "oktofeesh1",
      objective: "Find work without explicit surface",
    });
    expect(queued.run.surface).toBe("api");
    expect(sent).toContainEqual(expect.objectContaining({ type: "run-agent", requestedBy: "api" }));
    await expect(executeAgentRun(env, "missing-run")).rejects.toThrow("Agent run not found");

    const interruptedEnv = createTestEnv({
      JOBS: {
        async send() {
          throw "queue offline";
        },
      } as unknown as Queue,
    });
    const run: AgentRunRecord = {
      id: "run-interrupted",
      objective: "interrupt",
      actorLogin: "oktofeesh1",
      surface: "api",
      mode: "copilot",
      status: "queued",
      dataQualityStatus: "unknown",
      payload: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await createAgentRun(interruptedEnv, run);
    const tolerated = await executeAgentRun(interruptedEnv, run.id);
    expect(tolerated.run).toMatchObject({
      status: "needs_snapshot_refresh",
      payload: expect.objectContaining({
        rebuildEnqueued: false,
        refreshReason: "queue_unavailable",
        freshness: "missing",
      }),
    });
    const auditRows = ((await interruptedEnv.DB.prepare("SELECT event_type, actor, outcome FROM audit_events").all()) as { results: Array<{ event_type: string; actor: string | null; outcome: string | null }> }).results;
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "decision_pack.rebuild_enqueue_failed", actor: "oktofeesh1", outcome: "error" }),
      ]),
    );
  });

  it("ranks decision-pack actions, persists context snapshots, and sanitizes public summaries", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, decisionPackFixture());

    const bundle = await planNextWork(env, { login: "oktofeesh1", repoFullName: "we-promise/sure", objective: "Pick one action" });

    expect(bundle.run).toMatchObject({ status: "completed", dataQualityStatus: "degraded" });
    expect(bundle.actions[0]).toMatchObject({
      actionType: "cleanup_existing_prs",
      targetRepoFullName: "we-promise/sure",
      status: "blocked",
      approvalRequired: true,
      safetyClass: "private",
    });
    expect(bundle.actions[0]?.publicSafeSummary).not.toMatch(/reward|wallet|hotkey|raw trust score|estimated score/i);
    expect(bundle.contextSnapshots[0]).toMatchObject({
      scoringModelId: "scoring-1",
      freshnessWarnings: expect.arrayContaining(["we-promise/sure: partial signal coverage", "we-promise/sure: stale signal coverage"]),
    });
  });

  it("serves a stale decision pack as a completed run with degraded data quality and a freshness warning", async () => {
    const sent: unknown[] = [];
    const env = createTestEnv({
      JOBS: {
        async send(message: unknown) {
          sent.push(message);
        },
      } as unknown as Queue,
    });
    const stalePack = decisionPackFixture({
      generatedAt: "2026-01-01T00:00:00.000Z",
      dataQuality: {
        signalFidelity: {
          status: "complete",
          repoCount: 1,
          completeRepos: 1,
          degradedRepos: 0,
          blockedRepos: 0,
          partialRepos: [],
          cappedRepos: [],
          staleRepos: [],
          rateLimitedRepos: [],
        },
      } as unknown as ContributorDecisionPack["dataQuality"],
    });
    await persistSignalSnapshot(env, {
      id: "stale-pack-orch",
      signalType: CONTRIBUTOR_DECISION_PACK_SIGNAL,
      targetKey: stalePack.login,
      payload: stalePack as unknown as Record<string, JsonValue>,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    const bundle = await planNextWork(env, { login: "oktofeesh1", repoFullName: "we-promise/sure" });

    expect(bundle.run).toMatchObject({
      status: "completed",
      dataQualityStatus: "degraded",
      payload: expect.objectContaining({ freshness: "rebuilding", rebuildEnqueued: true, refreshReason: "stale_decision_pack" }),
    });
    expect(bundle.actions.length).toBeGreaterThan(0);
    expect(bundle.contextSnapshots[0]?.freshnessWarnings ?? []).toEqual(
      expect.arrayContaining([expect.stringMatching(/^decision pack is stale.*background rebuild enqueued$/)]),
    );
    expect(sent).toContainEqual({ type: "build-contributor-decision-packs", requestedBy: "api", login: "oktofeesh1" });
  });

  it("attaches optional Workers AI summaries when enabled", async () => {
    const env = createTestEnv({
      AI: { run: vi.fn(async () => ({ response: "Clean up queue pressure before adding more work." })) } as unknown as Ai,
      AI_SUMMARIES_ENABLED: "true",
      AI_DAILY_NEURON_BUDGET: "10000",
    });
    await persistDecisionPack(env, decisionPackFixture());

    const bundle = await planNextWork(env, { login: "oktofeesh1", repoFullName: "we-promise/sure", objective: "Pick one action" });

    expect(bundle.run.payload).toMatchObject({
      aiSummary: expect.objectContaining({
        status: "ok",
        text: "Clean up queue pressure before adding more work.",
      }),
    });
  });

  it("falls back to repo-fit actions when a snapshot has no top actions", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, decisionPackFixture({ topActions: [] }));

    const bundle = await planNextWork(env, { login: "oktofeesh1" });

    expect(bundle.actions.map((action) => action.actionType)).toContain("explain_repo_fit");
    expect(bundle.actions.some((action) => action.recommendation.includes("repo health") || action.recommendation.includes("Choose a different repo"))).toBe(true);
  });

  it("explains scoreability blockers from persisted decision packs", async () => {
    const env = createTestEnv();
    await persistDecisionPack(env, decisionPackFixture());

    const bundle = await explainBlockersWithAgent(env, { login: "oktofeesh1", repoFullName: "entrius/gittensor" });

    expect(bundle.actions).toHaveLength(1);
    expect(bundle.actions[0]).toMatchObject({
      actionType: "explain_score_blockers",
      status: "blocked",
      blockedBy: ["closed_pr_credibility", "low_credibility"],
    });
    expect(bundle.actions[0]?.rerunWhen).toContain("Rerun after");
  });

  it("covers pure action mapping, summaries, and public sanitization branches", () => {
    const generatedAt = nowIso();
    const run = __agentOrchestratorInternals.buildRunRecord({
      objective: "exercise pure branches",
      actorLogin: "oktofeesh1",
      surface: "mcp",
      status: "running",
      payload: {},
    });
    const avoidDecision = repoDecision({
      repoFullName: "owner/avoid",
      recommendation: "avoid_for_now",
      priorityScore: 1,
      scoreBlockers: [],
      nextActions: [],
    });
    const maintainerDecision = repoDecision({
      repoFullName: "owner/maintainer",
      recommendation: "maintainer_lane",
      priorityScore: 44,
      nextActions: [],
    });
    const criticalDecision = repoDecision({
      repoFullName: "owner/critical",
      recommendation: "pursue",
      priorityScore: 77,
      scoreBlockers: [{ code: "inactive_or_unknown_lane", repoFullName: "owner/critical", severity: "critical", detail: "Critical gate." }],
      riskReasons: [],
      nextActions: [],
    });
    const readyDecision = repoDecision({
      repoFullName: "owner/ready",
      recommendation: "pursue",
      priorityScore: 80,
      scoreBlockers: [],
      riskReasons: [],
      nextActions: ["Open a narrow, validated PR."],
    });

    expect(__agentOrchestratorInternals.mapDecisionAction("land_existing_prs")).toBe("monitor_existing_pr");
    expect(__agentOrchestratorInternals.mapDecisionAction("maintainer_cut_readiness")).toBe("explain_repo_fit");
    expect(__agentOrchestratorInternals.recommendationText(action("file_issue_discovery", "owner/issues", "watch", 30), readyDecision)).toMatch(/actionable/);
    expect(__agentOrchestratorInternals.recommendationText(action("maintainer_lane_improve_repo", "owner/maintainer", "maintainer_lane", 44), maintainerDecision)).toMatch(/maintainer-lane/);
    expect(__agentOrchestratorInternals.recommendationText({ ...action("open_new_direct_pr", "owner/ready", "pursue", 80), nextActions: [] }, readyDecision)).toMatch(/pick narrow work/i);
    expect(__agentOrchestratorInternals.maintainerImpactFor(maintainerDecision)).toMatch(/Repo-owner/);
    expect(__agentOrchestratorInternals.rerunWhenForDecision(criticalDecision)).toMatch(/blockers/);
    expect(__agentOrchestratorInternals.sameRepo("Owner/Repo", "owner/repo")).toBe(true);
    expect(__agentOrchestratorInternals.jsonPayload({ keep: "yes", drop: undefined })).toEqual({ keep: "yes" });
    expect(__agentOrchestratorInternals.sanitizePublicSummary("reward payout wallet hotkey raw trust score")).not.toMatch(/reward|payout|wallet|hotkey|raw trust score/i);

    const watchAction = __agentOrchestratorInternals.actionFromDecisionAction(run, action("open_new_direct_pr", "owner/avoid", "avoid_for_now", 1), avoidDecision, 0);
    const blockedAction = __agentOrchestratorInternals.actionFromDecisionAction(run, action("open_new_direct_pr", "owner/critical", "pursue", 77), criticalDecision, 1);
    const readyAction = __agentOrchestratorInternals.actionFromDecisionAction(run, action("open_new_direct_pr", "owner/ready", "pursue", 80), readyDecision, 2);
    const emptyNextAction = __agentOrchestratorInternals.actionFromDecisionAction(run, { ...action("open_new_direct_pr", "owner/ready", "pursue", 80), nextActions: [] }, readyDecision, 4);
    const repoFit = __agentOrchestratorInternals.actionFromRepoDecision(run, { ...readyDecision, nextActions: [] }, 3);
    const noDecisionActions = __agentOrchestratorInternals.buildDecisionActions(run, decisionPackFixture({ generatedAt, topActions: [], repoDecisions: [readyDecision] }), [readyDecision]);
    const blockerFallback = __agentOrchestratorInternals.buildBlockerActions(
      run,
      decisionPackFixture({ generatedAt, repoDecisions: [criticalDecision], topActions: [] }),
      [],
    );

    expect([watchAction.status, blockedAction.status, readyAction.status]).toEqual(["watch", "blocked", "recommended"]);
    expect(emptyNextAction.publicSafeSummary).toMatch(/Use Gittensory preflight/);
    expect(repoFit.recommendation).toMatch(/repo fit/);
    expect(noDecisionActions[0]).toMatchObject({ actionType: "explain_repo_fit", status: "recommended" });
    expect(blockerFallback[0]).toMatchObject({ actionType: "explain_score_blockers", status: "blocked" });
    expect(__agentOrchestratorInternals.summarizeRun({ ...run, status: "failed", errorSummary: undefined }, [])).toContain("unknown");
  });

  it("covers local action ready and blocker-free branches from prepared metadata", () => {
    const run = __agentOrchestratorInternals.buildRunRecord({
      objective: "local ready branch",
      actorLogin: "oktofeesh1",
      surface: "mcp",
      status: "running",
      payload: {},
    });
    const analysis = {
      repoFullName: "owner/ready",
      generatedAt: nowIso(),
      preflight: { status: "ready", findings: [] },
      lane: { lane: "direct_pr" },
      branchQualityBlockers: [],
      accountStateBlockers: [],
      scoreBlockers: [],
      scorePreview: {
        scoreabilityStatus: "scoreable",
        underlyingPotentialScore: 20,
        scoringModelSnapshotId: "scoring-ready",
      },
      scenarioScorePreview: { blockedBy: [] },
      rewardRisk: { summary: "Risk is acceptable." },
      maintainerFit: { risks: [] },
      recommendedRerunCondition: "Rerun before opening a PR.",
      prPacket: {
        validationSummary: { passed: 1 },
        publicSafeWarnings: [],
      },
      baseFreshness: { warnings: [] },
    } as any;

    const actions = __agentOrchestratorInternals.buildLocalBranchActions(run, analysis);
    const blockers = __agentOrchestratorInternals.buildLocalBlockerActions(run, analysis);
    const blockedActions = __agentOrchestratorInternals.buildLocalBranchActions(run, {
      ...analysis,
      scoreBlockers: ["Open PR pressure blocks current scoreability."],
      accountStateBlockers: ["Credibility is below the current floor."],
      scorePreview: { ...analysis.scorePreview, scoreabilityStatus: "blocked" },
      scenarioScorePreview: { blockedBy: [{ detail: "openPrMultiplier is 0." }] },
    });

    expect(actions.map((entry) => entry.actionType)).toEqual(["preflight_branch", "prepare_pr_packet"]);
    expect(actions[0]).toMatchObject({ status: "ready", scoreabilityImpact: "Current scoreability is not hard-blocked by branch metadata." });
    expect(blockers[0]).toMatchObject({ status: "ready", recommendation: "No hard scoreability blocker is visible from local metadata." });
    expect(blockedActions.map((entry) => entry.actionType)).toEqual(["preflight_branch", "prepare_pr_packet", "explain_score_blockers"]);
    expect(blockedActions[0]?.scoreabilityImpact).toContain("scenario projections");
  });

  it("covers watch, pursue, and no-blocker decision branches", async () => {
    const env = createTestEnv();
    const generatedAt = nowIso();
    const pursue = repoDecision({
      repoFullName: "touchpilot/touchpilot",
      recommendation: "pursue",
      priorityScore: 72,
      queue: { openIssues: 1, openPullRequests: 1, mergedPullRequests: 5, closedUnmergedPullRequests: 0 },
      nextActions: ["Pick one narrow change, link context clearly, run tests, and use local branch analysis before opening the PR."],
    });
    const watch = repoDecision({
      repoFullName: "entrius/allways",
      recommendation: "watch",
      priorityScore: 41,
      lane: {
        repoFullName: "entrius/allways",
        lane: "issue_discovery",
        issueDiscoveryShare: 1,
        directPrShare: 0,
        summary: "Issue-discovery lane.",
        contributorGuidance: "File actionable reports only.",
        maintainerGuidance: "Watch issue quality.",
      },
      scoreBlockers: [{ code: "issue_discovery_only", repoFullName: "entrius/allways", severity: "warning", detail: "This repo is issue-discovery-only." }],
      riskReasons: ["Direct PRs are not the useful lane here; use issue-discovery behavior only."],
      nextActions: ["File only high-confidence, actionable, non-duplicate issue-discovery reports."],
    });
    await persistDecisionPack(
      env,
      decisionPackFixture({
        generatedAt,
        repoDecisions: [pursue, watch],
        topActions: [
          action("open_new_direct_pr", "touchpilot/touchpilot", "pursue", 72),
          action("file_issue_discovery", "entrius/allways", "watch", 41),
        ],
        cleanupFirst: [],
        pursueRepos: [pursue],
        avoidRepos: [],
        maintainerLaneRepos: [],
        scoreBlockers: watch.scoreBlockers,
        dataQuality: {
          signalFidelity: {
            status: "degraded",
            repoCount: 2,
            completeRepos: 1,
            degradedRepos: 1,
            blockedRepos: 0,
            partialRepos: [],
            cappedRepos: ["entrius/allways"],
            staleRepos: [],
            rateLimitedRepos: ["entrius/allways"],
          },
        },
      }),
    );

    const plan = await planNextWork(env, { login: "oktofeesh1" });
    const noBlockers = await explainBlockersWithAgent(env, { login: "oktofeesh1", repoFullName: "touchpilot/touchpilot" });
    const noRepoBlockers = await explainBlockersWithAgent(env, { login: "oktofeesh1" });
    const missingRepoPlan = await planNextWork(env, { login: "oktofeesh1", repoFullName: "missing/repo" });

    const planRepos = plan.actions.map((entry) => entry.targetRepoFullName);
    expect(planRepos).toEqual(expect.arrayContaining(["touchpilot/touchpilot", "entrius/allways"]));
    const joined = plan.actions.map((entry) => entry.recommendation).join(" | ");
    expect(joined).toMatch(/touchpilot\/touchpilot:.*narrow change/);
    expect(joined).toMatch(/entrius\/allways:.*non-duplicate/);
    expect(plan.contextSnapshots[0]?.freshnessWarnings).toEqual(expect.arrayContaining(["entrius/allways: capped signal coverage", "entrius/allways: rate limited signal coverage"]));
    expect(noBlockers.actions[0]).toMatchObject({
      status: "ready",
      scoreabilityImpact: "Current signals do not show a hard scoreability gate.",
      blockedBy: [],
    });
    expect(noRepoBlockers.run.objective).toBe("Explain scoreability and review blockers.");
    expect(missingRepoPlan.actions.length).toBeGreaterThan(0);
  });

  it("marks failed runs without throwing when local branch input is malformed", async () => {
    const env = createTestEnv();
    const run: AgentRunRecord = {
      id: "run-malformed",
      objective: "bad local branch",
      actorLogin: "oktofeesh1",
      surface: "api",
      mode: "copilot",
      status: "queued",
      dataQualityStatus: "unknown",
      payload: { kind: "preflight_branch" },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await createAgentRun(env, run);

    const failed = await executeAgentRun(env, run.id);

    expect(failed.run.status).toBe("failed");
    expect(failed.summary).toContain("agent_local_branch_input_missing");
  });

  it("runs local branch agent flows from metadata only", async () => {
    const env = createTestEnv();
    await seedLocalBranchData(env);
    stubContributorFetch();
    const input = {
      login: "oktofeesh1",
      repoFullName: "entrius/allways-ui",
      baseRef: "origin/main",
      headRef: "feature/cache-fix",
      branchName: "fix-cache-7",
      baseSha: "base",
      headSha: "head",
      mergeBaseSha: "base",
      remoteTrackingSha: "base",
      changedFiles: [
        { path: "src/cache.ts", additions: 30, deletions: 4, status: "modified" as const },
        { path: "src/cache_test.ts", additions: 18, deletions: 0, status: "added" as const },
      ],
      linkedIssues: [7],
      labels: ["bug"],
      title: "Fix dashboard cache refresh after reconnect",
      body: "Fixes #7",
      validation: [{ command: "npm test -- cache", status: "passed" as const, summary: "cache tests passed" }],
      localScorer: { mode: "metadata_only" as const, sourceTokenScore: 40, totalTokenScore: 58, testTokenScore: 18, nonCodeTokenScore: 0 },
      expectedOpenPrCountAfterMerge: 1,
      projectedCredibility: 0.9,
      scenarioNotes: ["approved PRs may land first"],
    };

    const preflight = await preflightBranchWithAgent(env, input, "mcp");
    const packet = await preparePrPacketWithAgent(env, input, "mcp");
    const blockers = await explainBlockersWithAgent(env, input);

    expect(preflight.actions.map((action) => action.actionType)).toEqual(expect.arrayContaining(["preflight_branch", "prepare_pr_packet"]));
    expect(packet.actions).toHaveLength(1);
    expect(packet.actions[0]).toMatchObject({ actionType: "prepare_pr_packet", safetyClass: "public_safe", approvalRequired: false });
    expect(blockers.actions[0]).toMatchObject({ actionType: "explain_score_blockers", targetRepoFullName: "entrius/allways-ui" });
    expect(JSON.stringify(preflight.actions)).toContain("Source upload disabled");
  });
});

async function persistDecisionPack(env: Env, pack: ContributorDecisionPack): Promise<void> {
  await persistSignalSnapshot(env, {
    id: crypto.randomUUID(),
    signalType: CONTRIBUTOR_DECISION_PACK_SIGNAL,
    targetKey: pack.login,
    payload: pack as unknown as Record<string, JsonValue>,
    generatedAt: pack.generatedAt,
  });
}

function decisionPackFixture(overrides: Partial<ContributorDecisionPack> = {}): ContributorDecisionPack {
  const generatedAt = nowIso();
  const repoDecisions = [
    repoDecision({
      repoFullName: "we-promise/sure",
      recommendation: "cleanup_first",
      priorityScore: 94,
      scoreBlockers: [{ code: "open_pr_pressure", repoFullName: "we-promise/sure", severity: "critical", detail: "7 open PR(s) create scoreability and review-pressure risk." }],
      riskReasons: ["Contributor has 7 open PR(s) in this repo."],
      nextActions: ["Close, update, or land existing open PRs before opening more work."],
    }),
    repoDecision({
      repoFullName: "JSONbored/awesome-claude",
      recommendation: "maintainer_lane",
      priorityScore: 62,
      roleContext: {
        login: "oktofeesh1",
        role: "owner",
        repoFullName: "JSONbored/awesome-claude",
        generatedAt,
        maintainerLane: true,
        normalContributorEvidenceAllowed: false,
        source: "repo_owner_match",
        reasons: ["Owner of this repo."],
        guidance: "Use maintainer-lane guidance.",
      },
      scoreBlockers: [{ code: "maintainer_lane", repoFullName: "JSONbored/awesome-claude", severity: "info", detail: "Maintainer-lane activity is separate from normal outside-contributor reward evidence." }],
      nextActions: ["Improve contributor intake health, label clarity, and queue hygiene."],
    }),
    repoDecision({
      repoFullName: "entrius/gittensor",
      recommendation: "avoid_for_now",
      priorityScore: 31,
      scoreBlockers: [
        { code: "closed_pr_credibility", repoFullName: "entrius/gittensor", severity: "warning", detail: "Closed PR rate is 50%." },
        { code: "low_credibility", repoFullName: "entrius/gittensor", severity: "warning", detail: "Official repo credibility is 0.5." },
      ],
      riskReasons: ["Repo-specific closed PR rate is 50%."],
      nextActions: ["Choose a different repo or wait for cleaner lane/credibility conditions."],
    }),
  ] satisfies ContributorDecisionPack["repoDecisions"];
  const pack = {
    status: "ready",
    source: "computed",
    login: "oktofeesh1",
    generatedAt,
    stale: false,
    scoringModelSnapshotId: "scoring-1",
    profile: {
      login: "oktofeesh1",
      github: { login: "oktofeesh1", publicRepos: 8, followers: 2, topLanguages: ["TypeScript"], source: "github" },
      source: "gittensor_api",
      officialStats: {
        githubId: "123",
        githubUsername: "oktofeesh1",
        isEligible: true,
        credibility: 0.9,
        eligibleRepoCount: 2,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 1,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 0,
        taoPerDay: 0,
        usdPerDay: 0,
        totals: {
          pullRequests: 9,
          mergedPullRequests: 5,
          openPullRequests: 7,
          closedPullRequests: 2,
          openIssues: 0,
          closedIssues: 1,
          solvedIssues: 0,
          validSolvedIssues: 0,
        },
        repositories: [],
      },
      registeredRepoActivity: {
        pullRequests: 9,
        mergedPullRequests: 5,
        issues: 1,
        reposTouched: ["we-promise/sure", "entrius/gittensor"],
        dominantLabels: ["bug"],
      },
      trustSignals: {
        evidenceScore: 72,
        level: "established",
        unlinkedOpenPullRequests: 1,
        maintainerAssociatedPullRequests: 0,
      },
    },
    outcomeHistory: {
      login: "oktofeesh1",
      generatedAt,
      source: "gittensor_api",
      totals: {
        pullRequests: 9,
        mergedPullRequests: 5,
        openPullRequests: 7,
        closedPullRequests: 2,
        closedPullRequestRate: 0.22,
        issues: 1,
        openIssues: 0,
        closedIssues: 1,
        solvedIssues: 0,
        validSolvedIssues: 0,
        credibility: 0.9,
        issueCredibility: 1,
      },
      repoOutcomes: [],
      successPatterns: [],
      failurePatterns: [],
      maintainerLaneRepos: ["JSONbored/awesome-claude"],
    },
    roleContexts: [],
    repoDecisions,
    topActions: [
      action("cleanup_existing_prs", "we-promise/sure", "cleanup_first", 94),
      action("land_existing_prs", "we-promise/sure", "cleanup_first", 86),
      action("maintainer_lane_improve_repo", "JSONbored/awesome-claude", "maintainer_lane", 62),
      action("open_new_direct_pr", "entrius/gittensor", "avoid_for_now", 31),
    ],
    cleanupFirst: [repoDecisions[0]!],
    pursueRepos: [],
    avoidRepos: [repoDecisions[2]!],
    maintainerLaneRepos: [repoDecisions[1]!],
    scoreBlockers: repoDecisions.flatMap((decision) => decision.scoreBlockers),
    dataQuality: {
      signalFidelity: {
        status: "degraded",
        repoCount: 3,
        completeRepos: 2,
        degradedRepos: 1,
        blockedRepos: 0,
        partialRepos: ["we-promise/sure"],
        cappedRepos: [],
        staleRepos: ["we-promise/sure"],
        rateLimitedRepos: [],
      },
    },
    summary: "oktofeesh1 has ranked actions.",
    nextActions: ["Close, update, or land existing open PRs before opening more work."],
  } as unknown as ContributorDecisionPack;
  return { ...pack, ...overrides } as ContributorDecisionPack;
}

function repoDecision(overrides: Partial<ContributorDecisionPack["repoDecisions"][number]>): ContributorDecisionPack["repoDecisions"][number] {
  return {
    repoFullName: "owner/repo",
    recommendation: "pursue",
    priorityScore: 50,
    lane: {
      repoFullName: overrides.repoFullName ?? "owner/repo",
      lane: "direct_pr",
      issueDiscoveryShare: 0,
      directPrShare: 0.01,
      summary: "Direct PR lane.",
      contributorGuidance: "Submit focused PRs.",
      maintainerGuidance: "Review focused PRs.",
    },
    roleContext: {
      login: "oktofeesh1",
      role: "outside_contributor",
      repoFullName: overrides.repoFullName ?? "owner/repo",
      generatedAt: nowIso(),
      maintainerLane: false,
      normalContributorEvidenceAllowed: true,
      source: "gittensor_api",
      reasons: [],
      guidance: "Use contributor-lane guidance.",
    },
    queue: {
      openIssues: 3,
      openPullRequests: 5,
      mergedPullRequests: 2,
      closedUnmergedPullRequests: 1,
    },
    rewardUpside: {
      emissionShare: 0.01,
      directPrShare: 0.01,
      issueDiscoveryShare: 0,
      maintainerCut: 0,
    },
    scoreBlockers: [],
    riskReasons: [],
    languageMatch: { language: null, match: false },
    labelFit: [],
    whyThisHelps: [`${overrides.repoFullName ?? "owner/repo"}: private reward estimate should stay private.`],
    nextActions: ["Pick one narrow change and run branch preflight."],
    publicNextActions: [`${overrides.repoFullName ?? "owner/repo"}: Use Gittensory preflight before posting public PR context.`],
    ...overrides,
  } as ContributorDecisionPack["repoDecisions"][number];
}

function action(
  actionKind: ContributorDecisionPack["topActions"][number]["actionKind"],
  repoFullName: string,
  recommendation: ContributorDecisionPack["topActions"][number]["recommendation"],
  priorityScore: number,
): ContributorDecisionPack["topActions"][number] {
  const nextAction =
    actionKind === "file_issue_discovery"
      ? `${repoFullName}: file only actionable, non-duplicate issue-discovery reports.`
      : actionKind === "cleanup_existing_prs" || actionKind === "land_existing_prs"
        ? `${repoFullName}: close, update, or land your open PR(s) before opening more work.`
        : actionKind === "maintainer_lane_improve_repo" || actionKind === "maintainer_cut_readiness"
          ? `${repoFullName}: maintainer-lane repo health work; improve intake, label clarity, and queue hygiene.`
          : `${repoFullName}: pick one narrow change; run tests + branch preflight before opening the PR.`;
  return {
    actionKind,
    repoFullName,
    priorityScore,
    recommendation,
    whyThisHelps: [`${repoFullName}: action improves private scoreability.`],
    nextActions: [nextAction],
    publicNextActions: [`${repoFullName}: Use Gittensory preflight before posting public PR context.`],
  };
}

async function seedLocalBranchData(env: Env): Promise<void> {
  const registry = normalizeRegistryPayload(
    {
      "entrius/allways-ui": {
        emission_share: 0.011,
        issue_discovery_share: 0,
        label_multipliers: { bug: 1.1 },
        trusted_label_pipeline: true,
        maintainer_cut: 0,
      },
    },
    { kind: "raw-github", url: "fixture://registry" },
    "2026-05-28T00:00:00.000Z",
  );
  await persistRegistrySnapshot(env, registry);
  await upsertRepositoryFromGitHub(env, {
    name: "allways-ui",
    full_name: "entrius/allways-ui",
    private: false,
    default_branch: "main",
    owner: { login: "entrius" },
  });
  await persistScoringModelSnapshot(env, {
    id: "scoring-local",
    sourceKind: "test",
    sourceUrl: "fixture://scoring",
    fetchedAt: "2026-05-28T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {
      OSS_EMISSION_SHARE: 0.9,
      MERGED_PR_BASE_SCORE: 25,
      MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
      MAX_CODE_DENSITY_MULTIPLIER: 1.15,
      MAX_CONTRIBUTION_BONUS: 25,
      CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
      STANDARD_ISSUE_MULTIPLIER: 1.33,
      MAINTAINER_ISSUE_MULTIPLIER: 1.66,
      MIN_CREDIBILITY: 0.8,
      REVIEW_PENALTY_RATE: 0.15,
      EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
      OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
      MAX_OPEN_PR_THRESHOLD: 30,
      OPEN_PR_COLLATERAL_PERCENT: 0.2,
      SRC_TOK_SATURATION_SCALE: 58,
    },
    programmingLanguages: { TypeScript: 1 },
    registrySnapshotId: registry.id,
    warnings: [],
    payload: {},
  });
  await upsertIssueFromGitHub(env, "entrius/allways-ui", {
    number: 7,
    title: "Dashboard cache refresh fails",
    state: "open",
    user: { login: "reporter" },
    labels: [{ name: "bug" }],
    body: "Cache refresh fails after reconnect.",
  });
  await upsertPullRequestFromGitHub(env, "entrius/allways-ui", {
    number: 12,
    title: "Fix dashboard cache refresh",
    state: "open",
    user: { login: "oktofeesh1" },
    author_association: "NONE",
    head: { sha: "abc123", ref: "fix-cache" },
    base: { ref: "main" },
    labels: [{ name: "bug" }],
    body: "Fixes #7",
  });
  await upsertPullRequestFromGitHub(env, "entrius/allways-ui", {
    number: 13,
    title: "Alternative cache refresh",
    state: "open",
    user: { login: "other" },
    author_association: "NONE",
    head: { sha: "def456", ref: "alt-cache" },
    base: { ref: "main" },
    labels: [{ name: "bug" }],
    body: "Fixes #7",
  });
  await upsertRecentMergedPullRequest(env, {
    repoFullName: "entrius/allways-ui",
    number: 3,
    title: "Fix dashboard cache refresh after reconnect",
    authorLogin: "oktofeesh1",
    mergedAt: "2026-05-01T00:00:00.000Z",
    labels: ["bug"],
    linkedIssues: [7],
    changedFiles: ["src/cache.ts"],
    payload: {},
  });
}

function stubContributorFetch(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "https://api.gittensor.io/miners") {
      return Response.json([
        {
          uid: 7,
          githubUsername: "oktofeesh1",
          githubId: "123",
          totalPrs: 3,
          totalMergedPrs: 2,
          totalOpenPrs: 1,
          totalClosedPrs: 0,
          totalOpenIssues: 0,
          totalClosedIssues: 0,
          totalSolvedIssues: 0,
          totalValidSolvedIssues: 0,
          isEligible: true,
          credibility: 0.9,
          eligibleRepoCount: 1,
        },
      ]);
    }
    if (url === "https://api.gittensor.io/miners/123") {
      return Response.json({
        repositories: [
          {
            repositoryFullName: "entrius/allways-ui",
            totalPrs: "3",
            totalMergedPrs: "2",
            totalOpenPrs: "1",
            totalClosedPrs: "0",
            totalOpenIssues: "0",
            totalClosedIssues: "0",
            isEligible: true,
            credibility: "0.900000",
          },
        ],
      });
    }
    if (url === "https://api.gittensor.io/miners/123/prs") {
      return Response.json([{ repository: "entrius/allways-ui", pullRequestNumber: 12, pullRequestTitle: "Fix dashboard cache refresh", prState: "OPEN", label: "bug" }]);
    }
    if (url === "https://mirror.gittensor.io/api/v1/miners/123/issues") {
      return Response.json({ issues: [] });
    }
    if (url.endsWith("/users/oktofeesh1")) return Response.json({ login: "oktofeesh1", public_repos: 12, followers: 3 });
    if (url.includes("/users/oktofeesh1/repos")) return Response.json([{ language: "TypeScript" }]);
    return new Response("not found", { status: 404 });
  });
}
