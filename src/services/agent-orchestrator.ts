import {
  createAgentRun,
  getAgentRun,
  getRepository,
  listBountiesByRepo,
  listCheckSummaries,
  listAgentActions,
  listAgentContextSnapshots,
  listContributorIssues,
  listContributorPullRequests,
  listContributorRepoStats,
  listIssues,
  listPullRequests,
  listRecentMergedPullRequests,
  listRepositories,
  listRepoSyncStates,
  persistAgentContextSnapshot,
  recordAuditEvent,
  replaceAgentActions,
  updateAgentRun,
} from "../db/repositories";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot } from "../gittensor/api";
import { fetchPublicContributorProfile } from "../github/public";
import { getOrCreateScoringModelSnapshot } from "../scoring/model";
import { loadContributorDecisionPackForServing, repoDecisionFromPack, type ActionPortfolio, type ActionPortfolioBucketName, type ContributorDecisionPack, type DecisionAction, type RepoDecision, type RepoOutcomeSummary } from "./decision-pack";
import { loadOrComputeIssueQualityResponse } from "./issue-quality";
import { summarizeAgentBundleWithAi } from "./ai-summaries";
import { buildContributorFit, buildContributorOutcomeHistory, buildContributorProfile, buildContributorScoringProfile } from "../signals/engine";
import { buildContributorOpenPrMonitor, type ContributorOpenPrMonitor } from "../signals/contributor-open-pr-monitor";
import { buildLocalBranchAnalysis, findCurrentBranchPullRequest, type LocalBranchAnalysis, type LocalBranchAnalysisInput } from "../signals/local-branch";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { withAgentActionExplanationCard } from "./agent-action-explanation-card";
import type {
  AgentActionRecord,
  AgentActionStatus,
  AgentActionType,
  AgentContextSnapshotRecord,
  AgentRunRecord,
  AgentRunStatus,
  AgentSafetyClass,
  AgentSurface,
  JsonValue,
} from "../types";
import { nowIso } from "../utils/json";

export type AgentPlanRequest = {
  login: string;
  objective?: string | undefined;
  repoFullName?: string | undefined;
  surface?: AgentSurface | undefined;
};

export type AgentRunCreateRequest = {
  objective: string;
  actorLogin: string;
  surface?: AgentSurface | undefined;
  target?: {
    repoFullName?: string | undefined;
    pullNumber?: number | undefined;
    issueNumber?: number | undefined;
  } | undefined;
};

export type AgentRunBundle = {
  run: AgentRunRecord;
  actions: AgentActionRecord[];
  contextSnapshots: AgentContextSnapshotRecord[];
  summary: string;
};

type RecommendationConfidence = "high" | "medium" | "low";
type RecommendationFreshness = "fresh" | "stale" | "rebuilding" | "missing" | "degraded" | "possibly_stale" | "unknown";

type RecommendationEvidenceSource = {
  name: string;
  source: string | null;
  generatedAt: string | null;
  freshness: RecommendationFreshness;
  summary: string;
};

type RecommendationEvidence = {
  confidence: RecommendationConfidence;
  sourceSummary: string;
  freshness: RecommendationFreshness;
  sources: RecommendationEvidenceSource[];
  assumptions: string[];
  warnings: string[];
  userSuppliedScenarios: boolean;
  userSuppliedScenarioCount: number;
};

type LocalBranchActionAnalysis = LocalBranchAnalysis & {
  dataQuality?: { status: "complete" | "degraded" | "blocked" | "unknown"; warnings: string[] } | undefined;
};

export async function startAgentRun(env: Env, input: AgentRunCreateRequest): Promise<AgentRunBundle> {
  const run = buildRunRecord({
    objective: input.objective,
    actorLogin: input.actorLogin,
    surface: input.surface ?? "api",
    status: "queued",
    payload: jsonPayload({
      kind: "plan_next_work",
      login: input.actorLogin,
      repoFullName: input.target?.repoFullName,
      pullNumber: input.target?.pullNumber,
      issueNumber: input.target?.issueNumber,
    }),
  });
  await createAgentRun(env, run);
  await env.JOBS.send({ type: "run-agent", requestedBy: run.surface, runId: run.id });
  await recordAuditEvent(env, {
    eventType: "agent.run_created",
    actor: input.actorLogin,
    targetKey: input.target?.repoFullName,
    outcome: "queued",
    metadata: { runId: run.id, surface: run.surface, objective: input.objective },
  });
  return { run, actions: [], contextSnapshots: [], summary: `Queued Gittensory agent run ${run.id}.` };
}

export async function getAgentRunBundle(env: Env, runId: string): Promise<AgentRunBundle | null> {
  const run = await getAgentRun(env, runId);
  if (!run) return null;
  const [actions, contextSnapshots] = await Promise.all([listAgentActions(env, runId), listAgentContextSnapshots(env, runId)]);
  return {
    run,
    actions: actions.map(withAgentActionExplanationCard),
    contextSnapshots,
    summary: summarizeRun(run, actions),
  };
}

export async function planNextWork(env: Env, input: AgentPlanRequest): Promise<AgentRunBundle> {
  const run = buildRunRecord({
    objective: input.objective ?? "Plan the next Gittensor OSS contribution action.",
    actorLogin: input.login,
    surface: input.surface ?? "api",
    status: "running",
    payload: jsonPayload({ kind: "plan_next_work", ...input }),
  });
  await createAgentRun(env, run);
  return executeAgentRun(env, run.id);
}

export async function preflightBranchWithAgent(env: Env, input: LocalBranchAnalysisInput, surface: AgentSurface = "api"): Promise<AgentRunBundle> {
  const run = buildRunRecord({
    objective: `Preflight branch for ${input.repoFullName}.`,
    actorLogin: input.login,
    surface,
    status: "running",
    payload: { kind: "preflight_branch", input: input as unknown as Record<string, JsonValue> },
  });
  await createAgentRun(env, run);
  return executeAgentRun(env, run.id);
}

export async function preparePrPacketWithAgent(env: Env, input: LocalBranchAnalysisInput, surface: AgentSurface = "api"): Promise<AgentRunBundle> {
  const run = buildRunRecord({
    objective: `Prepare a public-safe PR packet for ${input.repoFullName}.`,
    actorLogin: input.login,
    surface,
    status: "running",
    payload: { kind: "prepare_pr_packet", input: input as unknown as Record<string, JsonValue> },
  });
  await createAgentRun(env, run);
  return executeAgentRun(env, run.id);
}

export async function explainBlockersWithAgent(env: Env, input: AgentPlanRequest | LocalBranchAnalysisInput): Promise<AgentRunBundle> {
  const login = input.login;
  const repoFullName = input.repoFullName;
  const isLocalBranch = "changedFiles" in input || "branchName" in input || "headRef" in input;
  const surface = "surface" in input ? (input.surface ?? "api") : "api";
  const run = buildRunRecord({
    objective: `Explain scoreability and review blockers${repoFullName ? ` for ${repoFullName}` : ""}.`,
    actorLogin: login,
    surface,
    status: "running",
    payload: isLocalBranch
      ? { kind: "explain_branch_blockers", input: input as unknown as Record<string, JsonValue> }
      : jsonPayload({ kind: "explain_blockers", ...(input as AgentPlanRequest) }),
  });
  await createAgentRun(env, run);
  return executeAgentRun(env, run.id);
}

export async function executeAgentRun(env: Env, runId: string): Promise<AgentRunBundle> {
  const run = await getAgentRun(env, runId);
  if (!run) throw new Error(`Agent run not found: ${runId}`);
  await updateAgentRun(env, runId, { status: "running" });
  try {
    const kind = String(run.payload.kind ?? "plan_next_work");
    const bundle =
      kind === "preflight_branch" || kind === "prepare_pr_packet" || kind === "explain_branch_blockers"
        ? await executeLocalBranchRun(env, run, kind)
        : await executeDecisionPackRun(env, run, kind);
    const summarized = await attachPrivateAiSummary(env, bundle);
    await recordAuditEvent(env, {
      eventType: "agent.run_completed",
      actor: run.actorLogin,
      targetKey: String(run.payload.repoFullName ?? ""),
      outcome: "completed",
      metadata: { runId, kind, actionCount: summarized.actions.length },
    });
    return summarized;
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent_run_failed";
    await updateAgentRun(env, runId, { status: "failed", errorSummary: message });
    await recordAuditEvent(env, {
      eventType: "agent.run_failed",
      actor: run.actorLogin,
      outcome: "error",
      detail: message,
      metadata: { runId },
    });
    const failed = await getAgentRunBundle(env, runId);
    if (!failed) throw error;
    return failed;
  }
}

async function attachPrivateAiSummary(env: Env, bundle: AgentRunBundle): Promise<AgentRunBundle> {
  const summary = await summarizeAgentBundleWithAi(env, bundle, "private");
  if (summary.status === "disabled" || summary.status === "unavailable") return bundle;
  await updateAgentRun(env, bundle.run.id, {
    payload: {
      ...bundle.run.payload,
      aiSummary: summary as unknown as JsonValue,
    },
  });
  return (await getAgentRunBundle(env, bundle.run.id)) ?? bundle;
}

async function executeDecisionPackRun(env: Env, run: AgentRunRecord, kind: string): Promise<AgentRunBundle> {
  const login = String(run.payload.login ?? run.actorLogin);
  const repoFullName = typeof run.payload.repoFullName === "string" ? run.payload.repoFullName : undefined;
  const serving = await loadContributorDecisionPackForServing(env, login);
  if (serving.kind === "needs_refresh") {
    await updateAgentRun(env, run.id, {
      status: "needs_snapshot_refresh",
      dataQualityStatus: "unknown",
      payload: {
        ...run.payload,
        rebuildEnqueued: serving.refresh.rebuildEnqueued,
        refreshReason: serving.refresh.rebuildEnqueued ? "missing_decision_pack" : "queue_unavailable",
        freshness: serving.refresh.freshness,
      },
    });
    return (await getAgentRunBundle(env, run.id))!;
  }
  const pack = {
    ...serving.pack,
    openPrMonitor: serving.pack.openPrMonitor ?? (await buildContributorOpenPrMonitor(env, login)),
  };
  const isStale = pack.freshness !== "fresh";
  const decisions = repoFullName ? pack.repoDecisions.filter((decision) => sameRepo(decision.repoFullName, repoFullName)) : pack.repoDecisions;
  const allowCrossRepoFallback = !repoFullName || run.surface !== "github_comment";
  const scopedDecisionActions = decisions.length > 0 ? decisions : allowCrossRepoFallback ? pack.repoDecisions : [];
  const actions =
    kind === "explain_blockers"
      ? buildBlockerActions(run, pack, decisions, { allowFallback: allowCrossRepoFallback })
      : buildDecisionActions(run, pack, scopedDecisionActions);
  const contexts = [contextSnapshotFromPack(run.id, pack, decisions)];
  const selectedActionPortfolio = contexts[0]?.payload.actionPortfolio ?? null;
  await replaceAgentActions(env, run.id, actions);
  await persistAgentContextSnapshot(env, contexts[0]!);
  const dataQualityStatus = isStale ? "degraded" : pack.dataQuality.signalFidelity.status;
  await updateAgentRun(env, run.id, {
    status: "completed",
    dataQualityStatus,
    payload: {
      ...run.payload,
      generatedAt: pack.generatedAt,
      actionCount: actions.length,
      freshness: pack.freshness,
      rebuildEnqueued: pack.rebuildEnqueued,
      actionPortfolio: selectedActionPortfolio,
      ...(isStale
        ? { refreshReason: pack.rebuildEnqueued ? "stale_decision_pack" : "stale_decision_pack_queue_unavailable" }
        : {}),
    },
  });
  return (await getAgentRunBundle(env, run.id))!;
}

async function executeLocalBranchRun(env: Env, run: AgentRunRecord, kind: string): Promise<AgentRunBundle> {
  const input = run.payload.input as unknown as LocalBranchAnalysisInput | undefined;
  if (!input?.login || !input.repoFullName) throw new Error("agent_local_branch_input_missing");
  const analysis = await analyzeLocalBranch(env, input);
  const actions =
    kind === "prepare_pr_packet"
      ? [localPrPacketAction(run, analysis)]
      : kind === "explain_branch_blockers"
        ? buildLocalBlockerActions(run, analysis)
        : buildLocalBranchActions(run, analysis);
  const context: AgentContextSnapshotRecord = {
    id: crypto.randomUUID(),
    runId: run.id,
    decisionPackVersion: analysis.generatedAt,
    scoringModelId: analysis.scorePreview.scoringModelSnapshotId,
    repoSignalSnapshotIds: [],
    freshnessWarnings: [...analysis.baseFreshness.warnings, ...(analysis.dataQuality?.warnings ?? [])],
    payload: {
      repoFullName: analysis.repoFullName,
      baseFreshness: analysis.baseFreshness as unknown as JsonValue,
      branchEligibility: analysis.branchEligibility as unknown as JsonValue,
      scoreabilityStatus: analysis.scorePreview.scoreabilityStatus,
      dataQuality: (analysis.dataQuality ?? null) as unknown as JsonValue,
    },
  };
  await replaceAgentActions(env, run.id, actions);
  await persistAgentContextSnapshot(env, context);
  await updateAgentRun(env, run.id, {
    status: "completed",
    dataQualityStatus: analysis.dataQuality?.status ?? "unknown",
    payload: { ...run.payload, generatedAt: analysis.generatedAt, actionCount: actions.length },
  });
  return (await getAgentRunBundle(env, run.id))!;
}

async function analyzeLocalBranch(env: Env, input: LocalBranchAnalysisInput): Promise<LocalBranchAnalysis & { dataQuality?: { status: "complete" | "degraded" | "blocked" | "unknown"; warnings: string[] } }> {
  const [github, contributorPullRequests, contributorIssues, repositories, syncStates, cachedRepoStats, gittensorSnapshot, repo, issues, pullRequests, recentMergedPullRequests, bounties, scoringSnapshot, issueQuality, repoManifest] =
    await Promise.all([
      fetchPublicContributorProfile(input.login),
      listContributorPullRequests(env, input.login),
      listContributorIssues(env, input.login),
      listRepositories(env),
      listRepoSyncStates(env),
      listContributorRepoStats(env, input.login),
      fetchGittensorContributorSnapshot(input.login),
      getRepository(env, input.repoFullName),
      listIssues(env, input.repoFullName),
      listPullRequests(env, input.repoFullName),
      listRecentMergedPullRequests(env, input.repoFullName),
      listBountiesByRepo(env, input.repoFullName),
      getOrCreateScoringModelSnapshot(env),
      loadOrComputeIssueQualityResponse(env, input.repoFullName),
      loadRepoFocusManifest(env, input.repoFullName),
    ]);
  const repoStats = contributorRepoStatsFromGittensor(gittensorSnapshot).length > 0 ? contributorRepoStatsFromGittensor(gittensorSnapshot) : cachedRepoStats;
  const profile = buildContributorProfile(input.login, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
  const outcomeHistory = buildContributorOutcomeHistory({ login: input.login, profile, repositories, pullRequests: contributorPullRequests, issues: contributorIssues, repoStats, cachedRepoStats });
  const fit = buildContributorFit(profile, repositories, [], [], syncStates, repoStats);
  const scoringProfile = buildContributorScoringProfile({ login: input.login, fit, scoringSnapshot });
  const checkSummaries = await loadCheckSummariesForPullRequests(env, input.repoFullName, input, pullRequests);
  // Caller-supplied focusManifest wins; otherwise fall back to the repo-owned manifest when present.
  const analysisInput = input.focusManifest !== undefined || !repoManifest.present
    ? input
    : { ...input, focusManifest: repoManifest as unknown };
  return buildLocalBranchAnalysis({
    input: analysisInput,
    repo,
    issues,
    pullRequests,
    contributorPullRequests,
    recentMergedPullRequests,
    bounties,
    repositories,
    checkSummaries,
    profile,
    outcomeHistory,
    scoringSnapshot,
    scoringProfile,
    issueQuality: issueQuality?.report,
    gittensorSnapshot,
  });
}

async function loadCheckSummariesForPullRequests(env: Env, repoFullName: string, input: Parameters<typeof findCurrentBranchPullRequest>[0], pullRequests: Parameters<typeof findCurrentBranchPullRequest>[1]) {
  const currentPullRequest = findCurrentBranchPullRequest(input, pullRequests);
  return currentPullRequest ? listCheckSummaries(env, repoFullName, currentPullRequest.number) : [];
}

function buildDecisionActions(run: AgentRunRecord, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentActionRecord[] {
  const decisionByRepo = new Map(decisions.map((decision) => [decision.repoFullName, decision]));
  const monitorActions = buildOpenPrMonitorActions(run, pack, decisions);
  const candidateActions = pack.topActions
    .filter((action) => decisionByRepo.has(action.repoFullName))
    .slice(0, 8)
    .map((action, index) => actionFromDecisionAction(run, action, decisionByRepo.get(action.repoFullName)!, monitorActions.length + index, pack));
  if (candidateActions.length > 0) return [...monitorActions, ...candidateActions].slice(0, 8);
  const fallback = decisions.slice(0, 5).map((decision, index) => actionFromRepoDecision(run, decision, monitorActions.length + index, pack));
  return [...monitorActions, ...fallback].slice(0, 8);
}

function buildOpenPrMonitorActions(run: AgentRunRecord, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentActionRecord[] {
  const monitor = pack.openPrMonitor;
  if (!monitor || monitor.pullRequests.length === 0) return [];
  const decisionByRepo = new Map(decisions.map((decision) => [decision.repoFullName.toLowerCase(), decision]));
  const urgentClassifications = new Set<ContributorOpenPrMonitor["pullRequests"][number]["classification"]>([
    "needs_author",
    "failing_checks",
    "duplicate_prone",
    "stale",
    "should_close_or_withdraw",
    "blocked",
  ]);
  return monitor.pullRequests
    .filter((packet) => urgentClassifications.has(packet.classification) && decisionByRepo.has(packet.repoFullName.toLowerCase()))
    .slice(0, 4)
    .map((packet, index) => {
      const decision = decisionByRepo.get(packet.repoFullName.toLowerCase())!;
      return actionRecord({
        run,
        actionType: "cleanup_existing_prs",
        index,
        targetRepoFullName: packet.repoFullName,
        targetPullNumber: packet.number,
        status: packet.classification === "approved" ? "recommended" : "blocked",
        recommendation: packet.nextSteps[0] ?? packet.summary,
        why: packet.reasons.slice(0, 4),
        scoreabilityImpact: monitor.cleanupFirst
          ? "Resolving open PR queue pressure can unblock scoreability before opening new work."
          : "Open PR hygiene affects maintainer review load and lane fit.",
        riskImpact: packet.classification === "duplicate_prone" ? "Duplicate or overlapping PRs increase collision risk." : "Stale or failing PRs consume review bandwidth.",
        maintainerImpact: "Focused cleanup reduces maintainer queue noise before new submissions.",
        blockedBy: [packet.classification],
        rerunWhen: "Rerun after this PR merges, closes, or passes checks and review.",
        publicSafeSummary: sanitizePublicSummary(`${packet.repoFullName}#${packet.number}: ${packet.summary}`),
        payload: {
          openPrPacket: packet as unknown as JsonValue,
          decision: decision as unknown as JsonValue,
        },
        evidence: decisionPackEvidence(pack, decision, "Open PR monitor recommendation from cached GitHub queue state."),
        safetyClass: "public_safe",
        approvalRequired: false,
      });
    });
}

function buildBlockerActions(
  run: AgentRunRecord,
  pack: ContributorDecisionPack,
  decisions: RepoDecision[],
  options: { allowFallback?: boolean } = {},
): AgentActionRecord[] {
  const selected = decisions.length > 0 ? decisions : options.allowFallback === false ? [] : pack.repoDecisions.filter((decision) => decision.scoreBlockers.length > 0).slice(0, 6);
  return selected.slice(0, 8).map((decision, index) =>
    actionRecord({
      run,
      actionType: "explain_score_blockers",
      index,
      targetRepoFullName: decision.repoFullName,
      status: decision.scoreBlockers.length > 0 ? "blocked" : "ready",
      recommendation: decision.scoreBlockers.length > 0 ? "Resolve scoreability blockers before adding work." : "No hard scoreability blocker is visible in the decision pack.",
      why: decision.scoreBlockers.map((blocker) => blocker.detail).concat(decision.riskReasons).slice(0, 6),
      scoreabilityImpact: decision.scoreBlockers.length > 0 ? "Clearing hard blockers can move the action from blocked to scoreable/conditionally scoreable." : "Current signals do not show a hard scoreability gate.",
      riskImpact: decision.riskReasons[0] ?? "No major repo-specific risk in current snapshot.",
      maintainerImpact: "Reducing blockers before submission keeps maintainer review focused on the actual change.",
      blockedBy: decision.scoreBlockers.map((blocker) => blocker.code),
      rerunWhen: "Rerun after open PRs merge/close, credibility updates, linked issue context changes, or validation changes.",
      publicSafeSummary: `${decision.repoFullName}: blocker context is available privately; public output should stay focused on review hygiene.`,
      payload: { decision: decision as unknown as JsonValue },
      evidence: decisionPackEvidence(pack, decision, "Scoreability blocker explanation from the contributor decision pack."),
    }),
  );
}

function buildLocalBranchActions(run: AgentRunRecord, analysis: LocalBranchActionAnalysis): AgentActionRecord[] {
  const actions: AgentActionRecord[] = [
    actionRecord({
      run,
      actionType: "preflight_branch",
      index: 0,
      targetRepoFullName: analysis.repoFullName,
      status: analysis.preflight.status === "ready" ? "ready" : "blocked",
      recommendation: analysis.preflight.status === "ready" ? "Branch is ready for a maintainer-friendly PR packet." : "Fix preflight findings before opening or updating the PR.",
      why: [
        `Preflight status is ${analysis.preflight.status}.`,
        `Lane is ${analysis.lane.lane}.`,
        ...analysis.branchQualityBlockers.slice(0, 3),
      ],
      scoreabilityImpact: analysis.scorePreview.scoreabilityStatus === "blocked" ? "Current scoreability is blocked; scenario projections show what changes after gates clear." : "Current scoreability is not hard-blocked by branch metadata.",
      riskImpact: analysis.scoreBlockers[0] ?? analysis.rewardRisk.summary,
      maintainerImpact: analysis.maintainerFit.risks[0] ?? "A narrow PR packet reduces review friction.",
      blockedBy: [...analysis.branchQualityBlockers, ...analysis.accountStateBlockers].slice(0, 8),
      rerunWhen: analysis.recommendedRerunCondition,
      publicSafeSummary: sanitizePublicSummary(`${analysis.repoFullName}: preflight found ${analysis.preflight.findings.length} finding(s); use the public-safe PR packet before posting.`),
      payload: { analysis: analysis as unknown as JsonValue },
      evidence: localBranchEvidence(analysis, "Local branch preflight recommendation from structured metadata."),
    }),
    localPrPacketAction(run, analysis, 1),
  ];
  if (analysis.scoreBlockers.length > 0 || analysis.accountStateBlockers.length > 0) actions.push(...buildLocalBlockerActions(run, analysis, 2));
  return actions.slice(0, 8);
}

function buildLocalBlockerActions(run: AgentRunRecord, analysis: LocalBranchActionAnalysis, startIndex = 0): AgentActionRecord[] {
  return [
    actionRecord({
      run,
      actionType: "explain_score_blockers",
      index: startIndex,
      targetRepoFullName: analysis.repoFullName,
      status: analysis.scoreBlockers.length > 0 || analysis.accountStateBlockers.length > 0 ? "blocked" : "ready",
      recommendation: analysis.scoreBlockers.length > 0 ? "Treat these as private scoreability blockers, not public PR copy." : "No hard scoreability blocker is visible from local metadata.",
      why: [...analysis.scoreBlockers, ...analysis.accountStateBlockers, ...analysis.scenarioScorePreview.blockedBy.map((blocker) => blocker.detail)].slice(0, 8),
      scoreabilityImpact: `Current status: ${analysis.scorePreview.scoreabilityStatus}; underlying potential: ${analysis.scorePreview.underlyingPotentialScore}.`,
      riskImpact: analysis.rewardRisk.summary,
      maintainerImpact: "Separate account/queue blockers from branch quality so maintainers only see actionable PR hygiene.",
      blockedBy: [...analysis.scoreBlockers, ...analysis.accountStateBlockers].slice(0, 8),
      rerunWhen: analysis.recommendedRerunCondition,
      publicSafeSummary: sanitizePublicSummary(`${analysis.repoFullName}: private blockers are separated from public PR guidance.`),
      payload: {
        scenarioScorePreview: analysis.scenarioScorePreview as unknown as JsonValue,
        baseFreshness: analysis.baseFreshness as unknown as JsonValue,
      },
      evidence: localBranchEvidence(analysis, "Private scoreability blocker explanation from local metadata."),
    }),
  ];
}

function localPrPacketAction(run: AgentRunRecord, analysis: LocalBranchActionAnalysis, index = 0): AgentActionRecord {
  return actionRecord({
    run,
    actionType: "prepare_pr_packet",
    index,
    targetRepoFullName: analysis.repoFullName,
    status: "ready",
    recommendation: "Use this public-safe packet when drafting PR text or a maintainer reply.",
    why: ["The packet excludes sensitive private scoring and identity context.", `Validation commands passed: ${analysis.prPacket.validationSummary.passed}.`],
    maintainerImpact: "A concise packet gives maintainers linked context, validation evidence, and next steps without noisy scoring language.",
    blockedBy: analysis.prPacket.publicSafeWarnings,
    rerunWhen: analysis.recommendedRerunCondition,
    publicSafeSummary: sanitizePublicSummary(`${analysis.repoFullName}: public-safe PR packet prepared from metadata only.`),
    payload: { prPacket: analysis.prPacket as unknown as JsonValue },
    evidence: localBranchEvidence(analysis, "Public-safe PR packet recommendation from local metadata."),
    safetyClass: "public_safe",
    approvalRequired: false,
  });
}

function actionFromDecisionAction(run: AgentRunRecord, action: DecisionAction, decision: RepoDecision, index: number, pack?: ContributorDecisionPack | undefined): AgentActionRecord {
  return actionRecord({
    run,
    actionType: mapDecisionAction(action.actionKind),
    index,
    targetRepoFullName: action.repoFullName,
    status: decision.recommendation === "avoid_for_now" ? "watch" : decision.scoreBlockers.some((blocker) => blocker.severity === "critical") ? "blocked" : "recommended",
    recommendation: recommendationText(action, decision),
    why: [...action.whyThisHelps, ...decision.riskReasons].slice(0, 6),
    scoreabilityImpact: decision.scoreBlockers.length > 0 ? `Blocked by ${decision.scoreBlockers.map((blocker) => blocker.code).join(", ")}.` : `Lane fit: ${decision.lane.lane}; direct PR share ${decision.rewardUpside.directPrShare}.`,
    riskImpact: decision.riskReasons[0] ?? "No major repo-specific risk is visible in the current decision pack.",
    maintainerImpact: maintainerImpactFor(decision),
    blockedBy: decision.scoreBlockers.map((blocker) => blocker.code),
    rerunWhen: rerunWhenForDecision(decision),
    publicSafeSummary: sanitizePublicSummary(action.publicNextActions?.[0] ?? decision.publicNextActions?.[0] ?? `${decision.repoFullName}: Use Gittensory preflight before posting public PR context.`),
    payload: {
      action: action as unknown as JsonValue,
      decision: decision as unknown as JsonValue,
    },
    evidence: pack ? decisionPackEvidence(pack, decision, "Ranked next-action recommendation from the contributor decision pack.") : repoDecisionEvidence(decision),
  });
}

function actionFromRepoDecision(run: AgentRunRecord, decision: RepoDecision, index: number, pack?: ContributorDecisionPack | undefined): AgentActionRecord {
  return actionRecord({
    run,
    actionType: "explain_repo_fit",
    index,
    targetRepoFullName: decision.repoFullName,
    status: decision.recommendation === "avoid_for_now" ? "watch" : "recommended",
    recommendation: decision.nextActions[0] ?? "Use repo fit context before choosing work.",
    why: decision.whyThisHelps.concat(decision.riskReasons).slice(0, 6),
    scoreabilityImpact: decision.scoreBlockers.length > 0 ? `Blocked by ${decision.scoreBlockers.map((blocker) => blocker.code).join(", ")}.` : `Risk-adjusted priority ${decision.priorityScore}.`,
    riskImpact: decision.riskReasons[0] ?? "No major repo-specific risk is visible in the current decision pack.",
    maintainerImpact: maintainerImpactFor(decision),
    blockedBy: decision.scoreBlockers.map((blocker) => blocker.code),
    rerunWhen: rerunWhenForDecision(decision),
    publicSafeSummary: sanitizePublicSummary(decision.publicNextActions?.[0] ?? `${decision.repoFullName}: Use local branch preflight before posting.`),
    payload: { decision: decision as unknown as JsonValue },
    evidence: pack ? decisionPackEvidence(pack, decision, "Repo-fit fallback recommendation from the contributor decision pack.") : repoDecisionEvidence(decision),
  });
}

function actionRecord(args: {
  run: AgentRunRecord;
  actionType: AgentActionType;
  index: number;
  targetRepoFullName?: string | undefined;
  targetPullNumber?: number | undefined;
  targetIssueNumber?: number | undefined;
  status: AgentActionStatus;
  recommendation: string;
  why: string[];
  scoreabilityImpact?: string | undefined;
  riskImpact?: string | undefined;
  maintainerImpact?: string | undefined;
  blockedBy: string[];
  rerunWhen?: string | undefined;
  publicSafeSummary: string;
  approvalRequired?: boolean | undefined;
  safetyClass?: AgentSafetyClass | undefined;
  payload: Record<string, JsonValue>;
  evidence?: RecommendationEvidence | undefined;
}): AgentActionRecord {
  const evidence = args.evidence ?? defaultRecommendationEvidence(args.actionType);
  const action: AgentActionRecord = {
    id: `${args.run.id}:${String(args.index).padStart(2, "0")}:${args.actionType}`,
    runId: args.run.id,
    actionType: args.actionType,
    targetRepoFullName: args.targetRepoFullName,
    targetPullNumber: args.targetPullNumber,
    targetIssueNumber: args.targetIssueNumber,
    status: args.status,
    recommendation: args.recommendation,
    why: args.why.filter(Boolean).slice(0, 8),
    scoreabilityImpact: args.scoreabilityImpact,
    riskImpact: args.riskImpact,
    maintainerImpact: args.maintainerImpact,
    blockedBy: [...new Set(args.blockedBy.filter(Boolean))].slice(0, 10),
    rerunWhen: args.rerunWhen,
    publicSafeSummary: sanitizePublicSummary(args.publicSafeSummary),
    approvalRequired: args.approvalRequired ?? true,
    safetyClass: args.safetyClass ?? "private",
    payload: {
      ...args.payload,
      recommendationEvidence: evidence as unknown as JsonValue,
    },
    createdAt: nowIso(),
  };
  return withAgentActionExplanationCard(action);
}

function decisionPackEvidence(pack: ContributorDecisionPack, decision: RepoDecision, sourceSummary: string): RecommendationEvidence {
  const repoQuality = repoSignalQuality(pack, decision.repoFullName);
  const userSuppliedScenarioCount = userSuppliedScenarioCountForRepo(pack, decision.repoFullName);
  const missingOfficialStats = !pack.profile.officialStats || pack.profile.source !== "gittensor_api";
  const missingRepoOutcome = !decision.outcome && !decision.roleContext.maintainerLane;
  const freshness = pack.freshness !== "fresh" ? pack.freshness : repoQuality.freshness;
  const outcomeQuality = aggregateOutcomeQuality(decision.repoOutcomePatterns);
  const warnings = uniqueStrings([
    ...(pack.freshness === "rebuilding" ? ["Decision pack is stale; a background rebuild was enqueued."] : []),
    ...(pack.freshness === "stale" ? ["Decision pack is stale and no rebuild was enqueued."] : []),
    ...(pack.dataQuality.signalFidelity.status === "blocked" ? ["Signal fidelity is blocked for this decision pack."] : []),
    ...repoQuality.warnings,
    ...(missingOfficialStats ? ["Official Gittensor contributor stats were unavailable; confidence is reduced."] : []),
    ...(missingRepoOutcome ? ["No repo-specific official outcome row was available; confidence is reduced."] : []),
    ...(outcomeQuality.warning ? [outcomeQuality.warning] : []),
  ]);
  const assumptions = uniqueStrings([
    ...(missingOfficialStats ? ["Contributor-level official stats are missing, so cached GitHub and registry data carry more weight."] : []),
    ...(missingRepoOutcome ? ["Repo-specific prior outcomes are missing, so queue, lane, and role heuristics carry more weight."] : []),
    ...(userSuppliedScenarioCount > 0 ? ["Pending-PR scenario projections include user-supplied assumptions."] : []),
    ...(outcomeQuality.assumption ? [outcomeQuality.assumption] : []),
  ]);
  return {
    confidence: confidenceForDecisionPack(pack, decision, repoQuality, userSuppliedScenarioCount),
    sourceSummary,
    freshness,
    sources: [
      evidenceSource("contributor_decision_pack", pack.source, pack.generatedAt, pack.freshness, `${pack.login} decision pack with ${pack.dataQuality.signalFidelity.status} signal fidelity.`),
      evidenceSource("repo_decision", decision.roleContext.source, pack.generatedAt, repoQuality.freshness, `${decision.repoFullName} ranked ${decision.recommendation} at priority ${decision.priorityScore}.`),
      evidenceSource(
        "official_contributor_stats",
        pack.profile.source,
        pack.generatedAt,
        missingOfficialStats ? "missing" : "fresh",
        missingOfficialStats ? "Official contributor stats missing for this snapshot." : "Official contributor stats present in this snapshot.",
      ),
      evidenceSource(
        "repo_outcome_history",
        decision.outcome ? pack.outcomeHistory.source : null,
        pack.generatedAt,
        decision.outcome ? "fresh" : "missing",
        decision.outcome ? "Repo-specific contributor outcomes present." : "Repo-specific contributor outcomes missing.",
      ),
      evidenceSource(
        "aggregate_outcome_quality",
        decision.repoOutcomePatterns ? "cached_repo_patterns" : null,
        pack.generatedAt,
        outcomeQuality.freshness,
        outcomeQuality.sourceSummary,
      ),
      ...(pack.openPrMonitor
        ? [evidenceSource("open_pr_monitor", "cached_github_data", pack.openPrMonitor.generatedAt, pack.freshness === "fresh" ? "fresh" : pack.freshness, pack.openPrMonitor.summary)]
        : []),
    ],
    assumptions,
    warnings,
    userSuppliedScenarios: userSuppliedScenarioCount > 0,
    userSuppliedScenarioCount,
  };
}

function repoDecisionEvidence(decision: RepoDecision): RecommendationEvidence {
  const missingRepoOutcome = !decision.outcome && !decision.roleContext.maintainerLane;
  return {
    confidence: missingRepoOutcome ? "medium" : "high",
    sourceSummary: "Repo decision recommendation without serving-pack freshness metadata.",
    freshness: "unknown",
    sources: [
      evidenceSource("repo_decision", decision.roleContext.source, null, "unknown", `${decision.repoFullName} ranked ${decision.recommendation} at priority ${decision.priorityScore}.`),
      evidenceSource("repo_outcome_history", decision.outcome ? "gittensor_api" : null, null, decision.outcome ? "fresh" : "missing", decision.outcome ? "Repo-specific contributor outcomes present." : "Repo-specific contributor outcomes missing."),
    ],
    assumptions: missingRepoOutcome ? ["Repo-specific prior outcomes are missing, so queue, lane, and role heuristics carry more weight."] : [],
    warnings: missingRepoOutcome ? ["No repo-specific official outcome row was available; confidence is reduced."] : [],
    userSuppliedScenarios: false,
    userSuppliedScenarioCount: 0,
  };
}

function localBranchEvidence(analysis: LocalBranchActionAnalysis, sourceSummary: string): RecommendationEvidence {
  const freshness = localEvidenceFreshness(analysis);
  const userSuppliedScenarioCount = analysis.scorePreview.scenarioPreviews.filter((scenario) => scenario.source === "user_supplied").length;
  const userSuppliedLinkedIssue = analysis.scorePreview.linkedIssueMultiplier.source === "user_supplied";
  const userSuppliedBranchEligibility = analysis.branchEligibility.source === "user_supplied";
  const userSuppliedScenarios = userSuppliedScenarioCount > 0 || userSuppliedLinkedIssue || userSuppliedBranchEligibility;
  const warnings = uniqueStrings([
    ...analysis.baseFreshness.warnings,
    ...(analysis.dataQuality?.warnings ?? []),
    ...analysis.scorePreview.warnings,
    ...analysis.branchEligibility.warnings,
    ...(analysis.githubBranchStatus.status === "unknown" ? analysis.githubBranchStatus.notes : []),
  ]);
  const assumptions = uniqueStrings([
    "Local agent analysis used structured git and GitHub metadata only; source contents were not uploaded.",
    ...analysis.scorePreview.assumptions.filter((assumption) => /scenario|linked issue|advisory|metadata|branch/i.test(assumption)).slice(0, 8),
    ...(userSuppliedScenarios ? ["One or more scenario, linked-issue, or branch-eligibility inputs were supplied by the caller."] : []),
  ]);
  return {
    confidence: confidenceForLocalBranch(analysis, userSuppliedScenarios),
    sourceSummary,
    freshness,
    sources: [
      evidenceSource("local_branch_metadata", "metadata_only", analysis.generatedAt, freshness, "Structured local branch metadata; source upload disabled."),
      evidenceSource("base_branch_freshness", "local_git_metadata", analysis.generatedAt, localFreshnessStatus(analysis.baseFreshness.status), `${analysis.baseFreshness.status} base/head metadata.`),
      evidenceSource("score_preview", analysis.scorePreview.activeModel, analysis.scorePreview.generatedAt, "fresh", `${analysis.scorePreview.scoreabilityStatus} private score preview.`),
      evidenceSource("github_branch_status", analysis.githubBranchStatus.source, analysis.generatedAt, analysis.githubBranchStatus.status === "unknown" ? "unknown" : "fresh", `${analysis.githubBranchStatus.status} cached GitHub branch status.`),
      evidenceSource("linked_issue_multiplier", analysis.scorePreview.linkedIssueMultiplier.source, analysis.scorePreview.generatedAt, analysis.scorePreview.linkedIssueMultiplier.status === "unavailable" ? "missing" : "fresh", analysis.scorePreview.linkedIssueMultiplier.reason),
    ],
    assumptions,
    warnings,
    userSuppliedScenarios,
    userSuppliedScenarioCount,
  };
}

function defaultRecommendationEvidence(actionType: AgentActionType): RecommendationEvidence {
  return {
    confidence: "medium",
    sourceSummary: "Generated from Gittensory agent metadata.",
    freshness: "unknown",
    sources: [evidenceSource("agent_action", null, null, "unknown", `${actionType} action generated without source-specific evidence.`)],
    assumptions: [],
    warnings: ["Source-specific evidence was not attached; treat this recommendation as medium confidence."],
    userSuppliedScenarios: false,
    userSuppliedScenarioCount: 0,
  };
}

const OUTCOME_QUALITY_MIN_SAMPLE = 5;
const OUTCOME_QUALITY_STRONG_MERGE_RATE = 0.6;
const OUTCOME_QUALITY_HIGH_RISK_RATE = 0.3;

type AggregateOutcomeQuality = {
  signal: "strong" | "weak" | "high_risk" | "sparse" | "absent";
  mergeRate: number | null;
  sampleSize: number;
  warning: string | null;
  assumption: string | null;
  sourceSummary: string;
  freshness: RecommendationFreshness;
};

function aggregateOutcomeQuality(patterns: RepoOutcomeSummary | undefined): AggregateOutcomeQuality {
  if (!patterns) {
    return {
      signal: "absent",
      mergeRate: null,
      sampleSize: 0,
      warning: null,
      assumption: "No aggregate repo outcome quality data is available; heuristic signals carry more weight.",
      sourceSummary: "No aggregate repo outcome quality data available.",
      freshness: "missing",
    };
  }
  const { outsideContributorMergeRate: mergeRate, sampleSize } = patterns;
  if (sampleSize < OUTCOME_QUALITY_MIN_SAMPLE) {
    return {
      signal: "sparse",
      mergeRate,
      sampleSize,
      warning: null,
      assumption: `Aggregate repo outcome quality has limited sample size (${sampleSize} decided PR(s)); signals carry reduced weight.`,
      sourceSummary: `Sparse aggregate outcome data (${sampleSize} decided PR(s)); confidence impact is limited.`,
      freshness: "degraded",
    };
  }
  if (mergeRate >= OUTCOME_QUALITY_STRONG_MERGE_RATE) {
    return {
      signal: "strong",
      mergeRate,
      sampleSize,
      warning: null,
      assumption: null,
      sourceSummary: `Aggregate outside-contributor merge rate is strong across ${sampleSize} decided PR(s).`,
      freshness: "fresh",
    };
  }
  if (mergeRate <= OUTCOME_QUALITY_HIGH_RISK_RATE) {
    return {
      signal: "high_risk",
      mergeRate,
      sampleSize,
      warning: `Aggregate repo outcome quality shows high closure risk across ${sampleSize} decided PR(s); review risk patterns before opening work.`,
      assumption: null,
      sourceSummary: `Aggregate outside-contributor merge rate is low across ${sampleSize} decided PR(s); high closure risk.`,
      freshness: "fresh",
    };
  }
  return {
    signal: "weak",
    mergeRate,
    sampleSize,
    warning: `Aggregate repo outcome quality shows moderate closure risk across ${sampleSize} decided PR(s).`,
    assumption: null,
    sourceSummary: `Aggregate outside-contributor merge rate is moderate across ${sampleSize} decided PR(s).`,
    freshness: "fresh",
  };
}

function confidenceForDecisionPack(
  pack: ContributorDecisionPack,
  decision: RepoDecision,
  repoQuality: { freshness: RecommendationFreshness; warnings: string[] },
  userSuppliedScenarioCount: number,
): RecommendationConfidence {
  let confidence: RecommendationConfidence = "high";
  const fidelity = pack.dataQuality.signalFidelity;
  if (pack.freshness !== "fresh" || fidelity.status === "blocked" || repoQuality.freshness === "stale" || repoQuality.warnings.some((warning) => /rate limited/i.test(warning))) {
    confidence = lowerConfidence(confidence, "low");
  } else if (fidelity.status !== "complete" || repoQuality.freshness === "degraded") {
    confidence = lowerConfidence(confidence, "medium");
  }
  if (!pack.profile.officialStats || pack.profile.source !== "gittensor_api") confidence = lowerConfidence(confidence, "medium");
  if (!decision.outcome && !decision.roleContext.maintainerLane) confidence = lowerConfidence(confidence, "medium");
  if (userSuppliedScenarioCount > 0) confidence = lowerConfidence(confidence, "medium");
  const outcomeQuality = aggregateOutcomeQuality(decision.repoOutcomePatterns);
  if (outcomeQuality.signal === "high_risk") confidence = lowerConfidence(confidence, "low");
  else if (outcomeQuality.signal === "weak") confidence = lowerConfidence(confidence, "medium");
  return confidence;
}

function confidenceForLocalBranch(analysis: LocalBranchActionAnalysis, userSuppliedScenarios: boolean): RecommendationConfidence {
  let confidence: RecommendationConfidence = "high";
  if (analysis.baseFreshness.status === "stale" || analysis.dataQuality?.status === "blocked") confidence = lowerConfidence(confidence, "low");
  if (analysis.baseFreshness.status === "possibly_stale" || analysis.baseFreshness.status === "unknown") confidence = lowerConfidence(confidence, "medium");
  if (analysis.dataQuality && analysis.dataQuality.status !== "complete") confidence = lowerConfidence(confidence, "medium");
  if (analysis.githubBranchStatus.status === "unknown") confidence = lowerConfidence(confidence, "medium");
  if (analysis.branchEligibility.stale || analysis.branchEligibility.evidence === "missing") confidence = lowerConfidence(confidence, "medium");
  if (userSuppliedScenarios) confidence = lowerConfidence(confidence, "medium");
  if (analysis.scorePreview.warnings.some((warning) => /unavailable|missing|stale/i.test(warning))) confidence = lowerConfidence(confidence, "medium");
  return confidence;
}

function repoSignalQuality(pack: ContributorDecisionPack, repoFullName: string): { freshness: RecommendationFreshness; warnings: string[] } {
  const fidelity = pack.dataQuality.signalFidelity;
  const repo = repoFullName.toLowerCase();
  const has = (repos: string[]) => repos.some((entry) => entry.toLowerCase() === repo);
  const warnings = [
    ...(has(fidelity.partialRepos) ? [`${repoFullName}: partial signal coverage.`] : []),
    ...(has(fidelity.cappedRepos) ? [`${repoFullName}: capped signal coverage.`] : []),
    ...(has(fidelity.staleRepos) ? [`${repoFullName}: stale signal coverage.`] : []),
    ...(has(fidelity.rateLimitedRepos) ? [`${repoFullName}: rate limited signal coverage.`] : []),
  ];
  if (has(fidelity.staleRepos)) return { freshness: "stale", warnings };
  if (warnings.length > 0 || fidelity.status !== "complete") return { freshness: "degraded", warnings };
  return { freshness: "fresh", warnings };
}

function localEvidenceFreshness(analysis: LocalBranchActionAnalysis): RecommendationFreshness {
  if (analysis.baseFreshness.status === "stale") return "stale";
  if (analysis.baseFreshness.status === "possibly_stale") return "possibly_stale";
  if (analysis.baseFreshness.status === "unknown") return "unknown";
  if (analysis.dataQuality && analysis.dataQuality.status !== "complete") return "degraded";
  return "fresh";
}

function localFreshnessStatus(status: LocalBranchAnalysis["baseFreshness"]["status"]): RecommendationFreshness {
  if (status === "possibly_stale") return "possibly_stale";
  return status;
}

function userSuppliedScenarioCountForRepo(pack: ContributorDecisionPack, repoFullName: string): number {
  return (pack.openPrMonitor?.pendingScenarios ?? []).filter((scenario) => sameRepo(scenario.repoFullName, repoFullName) && scenario.detection.source === "user_supplied").length;
}

function lowerConfidence(current: RecommendationConfidence, target: RecommendationConfidence): RecommendationConfidence {
  const rank: Record<RecommendationConfidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[target] < rank[current] ? target : current;
}

function evidenceSource(name: string, source: string | null | undefined, generatedAt: string | null | undefined, freshness: RecommendationFreshness, summary: string): RecommendationEvidenceSource {
  return {
    name,
    source: source ?? null,
    generatedAt: generatedAt ?? null,
    freshness,
    summary,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function contextSnapshotFromPack(runId: string, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentContextSnapshotRecord {
  const fidelity = pack.dataQuality.signalFidelity;
  const ageSeconds = pack.snapshotAgeSeconds ?? null;
  const ageNote = ageSeconds !== null ? ` (age ${ageSeconds}s)` : "";
  const freshnessWarning =
    pack.freshness === "rebuilding"
      ? `decision pack is stale${ageNote}; background rebuild enqueued`
      : pack.freshness === "stale"
        ? `decision pack is stale${ageNote}; rebuild not enqueued`
        : null;
  const warnings = [
    ...(freshnessWarning ? [freshnessWarning] : []),
    ...fidelity.partialRepos.map((repo) => `${repo}: partial signal coverage`),
    ...fidelity.cappedRepos.map((repo) => `${repo}: capped signal coverage`),
    ...fidelity.staleRepos.map((repo) => `${repo}: stale signal coverage`),
    ...fidelity.rateLimitedRepos.map((repo) => `${repo}: rate limited signal coverage`),
  ];
  return {
    id: crypto.randomUUID(),
    runId,
    decisionPackVersion: pack.generatedAt,
    repoSignalSnapshotIds: [],
    scoringModelId: pack.scoringModelSnapshotId,
    freshnessWarnings: warnings,
    payload: {
      login: pack.login,
      source: pack.source,
      selectedRepos: decisions.map((decision) => decision.repoFullName),
      actionPortfolio: scopedActionPortfolio(pack.actionPortfolio, decisions) as unknown as JsonValue,
      evidenceGraph: (pack.evidenceGraph
        ? {
            version: pack.evidenceGraph.version,
            generatedAt: pack.evidenceGraph.generatedAt,
            totals: pack.evidenceGraph.totals,
            sources: pack.evidenceGraph.sources,
            selectedRepos: pack.evidenceGraph.repos.filter((repo) => decisions.some((decision) => decision.repoFullName.toLowerCase() === repo.repoFullName.toLowerCase())),
          }
        : null) as unknown as JsonValue,
      dataQuality: pack.dataQuality as unknown as JsonValue,
      openPrMonitor: (pack.openPrMonitor ?? null) as unknown as JsonValue,
    },
  };
}

function scopedActionPortfolio(portfolio: ActionPortfolio | undefined, decisions: RepoDecision[]): ActionPortfolio | null {
  if (!portfolio) return null;
  const repoKeys = new Set(decisions.map((decision) => decision.repoFullName.toLowerCase()));
  if (repoKeys.size === 0) return null;
  const buckets = portfolio.buckets.map((bucket) => ({
    ...bucket,
    actions: bucket.actions.filter((action) => repoKeys.has(action.repoFullName.toLowerCase())),
  }));
  const topActions = portfolio.topActions.filter((action) => repoKeys.has(action.repoFullName.toLowerCase()));
  const counts = Object.fromEntries(buckets.map((bucket) => [bucket.bucket, bucket.actions.length])) as Record<ActionPortfolioBucketName, number>;
  const activeBuckets = buckets.filter((bucket) => bucket.actions.length > 0);
  return {
    ...portfolio,
    buckets,
    topActions,
    counts,
    summary:
      activeBuckets.length === 0
        ? "No portfolio actions are currently available for the selected repo scope."
        : `Scoped portfolio has ${topActions.length} action(s) across ${activeBuckets.length} active bucket(s): ${activeBuckets.map((bucket) => `${bucket.bucket} ${bucket.actions.length}`).join(", ")}.`,
  };
}

function buildRunRecord(args: {
  objective: string;
  actorLogin: string;
  surface: AgentSurface;
  status: AgentRunStatus;
  payload: Record<string, JsonValue>;
}): AgentRunRecord {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    objective: args.objective,
    actorLogin: args.actorLogin,
    surface: args.surface,
    mode: "copilot",
    status: args.status,
    dataQualityStatus: "unknown",
    payload: args.payload,
    createdAt: now,
    updatedAt: now,
  };
}

function mapDecisionAction(kind: DecisionAction["actionKind"]): AgentActionType {
  if (kind === "cleanup_existing_prs") return "cleanup_existing_prs";
  if (kind === "land_existing_prs") return "monitor_existing_pr";
  if (kind === "maintainer_lane_improve_repo" || kind === "maintainer_cut_readiness") return "explain_repo_fit";
  return "choose_next_work";
}

function recommendationText(action: DecisionAction, decision: RepoDecision): string {
  if (action.actionKind === "cleanup_existing_prs") return `${decision.repoFullName}: clean up existing PR pressure before opening new work.`;
  if (action.actionKind === "land_existing_prs") return `${decision.repoFullName}: focus on landing or closing already-open PRs.`;
  if (action.actionKind === "file_issue_discovery") return `${decision.repoFullName}: only file an actionable, non-duplicate issue-discovery report.`;
  if (action.actionKind === "maintainer_lane_improve_repo" || action.actionKind === "maintainer_cut_readiness") {
    return `${decision.repoFullName}: maintainer-lane repo health work, not outside-contributor evidence.`;
  }
  return action.nextActions[0] ?? `${decision.repoFullName}: pick narrow work and run branch preflight before opening a PR.`;
}

function maintainerImpactFor(decision: RepoDecision): string {
  if (decision.recommendation === "cleanup_first") return "Cleanup lowers active-review pressure before adding more queue load.";
  if (decision.recommendation === "maintainer_lane") return "Repo-owner work should improve intake quality and contributor routing.";
  return "Narrow, validated work with clear lane fit is easier to review.";
}

function rerunWhenForDecision(decision: RepoDecision): string {
  if (decision.recommendation === "cleanup_first") return "Rerun after open PRs merge, close, or are withdrawn.";
  if (decision.scoreBlockers.length > 0) return "Rerun after the listed scoreability blockers change.";
  return "Rerun before opening a PR or when repo queue/registry signals change.";
}

function summarizeRun(run: AgentRunRecord, actions: AgentActionRecord[]): string {
  if (run.status === "needs_snapshot_refresh") return `Agent run ${run.id} needs a contributor decision-pack refresh.`;
  if (run.status === "failed") return `Agent run ${run.id} failed: ${run.errorSummary ?? "unknown error"}.`;
  return `Agent run ${run.id} has ${actions.length} ranked action(s).`;
}

function sanitizePublicSummary(value: string): string {
  return value
    .replace(/\b(reward|payout|farming|estimated score|raw trust score|wallet|hotkey|coldkey)\b/gi, "private signal")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonPayload(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Record<string, JsonValue>;
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export const __agentOrchestratorInternals = {
  buildDecisionActions,
  buildOpenPrMonitorActions,
  buildBlockerActions,
  buildLocalBranchActions,
  buildLocalBlockerActions,
  localPrPacketAction,
  actionFromDecisionAction,
  actionFromRepoDecision,
  actionRecord,
  contextSnapshotFromPack,
  scopedActionPortfolio,
  buildRunRecord,
  mapDecisionAction,
  recommendationText,
  maintainerImpactFor,
  rerunWhenForDecision,
  summarizeRun,
  sanitizePublicSummary,
  jsonPayload,
  sameRepo,
  aggregateOutcomeQuality,
};
