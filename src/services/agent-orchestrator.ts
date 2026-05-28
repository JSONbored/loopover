import {
  createAgentRun,
  getAgentRun,
  getRepository,
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
import { loadFreshContributorDecisionPack, repoDecisionFromPack, type ContributorDecisionPack, type DecisionAction, type RepoDecision } from "./decision-pack";
import { summarizeAgentBundleWithAi } from "./ai-summaries";
import { buildContributorFit, buildContributorOutcomeHistory, buildContributorProfile, buildContributorScoringProfile } from "../signals/engine";
import { buildLocalBranchAnalysis, type LocalBranchAnalysis, type LocalBranchAnalysisInput } from "../signals/local-branch";
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
    actions,
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
  const run = buildRunRecord({
    objective: `Explain scoreability and review blockers${repoFullName ? ` for ${repoFullName}` : ""}.`,
    actorLogin: login,
    surface: "api",
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
  const pack = await loadFreshContributorDecisionPack(env, login);
  if (!pack) {
    await env.JOBS.send({ type: "build-contributor-decision-packs", requestedBy: "api", login });
    await updateAgentRun(env, run.id, {
      status: "needs_snapshot_refresh",
      dataQualityStatus: "unknown",
      payload: { ...run.payload, snapshotRefreshEnqueued: true, refreshReason: "missing_or_stale_decision_pack" },
    });
    return (await getAgentRunBundle(env, run.id))!;
  }
  const decisions = repoFullName ? pack.repoDecisions.filter((decision) => sameRepo(decision.repoFullName, repoFullName)) : pack.repoDecisions;
  const actions =
    kind === "explain_blockers"
      ? buildBlockerActions(run, pack, decisions)
      : buildDecisionActions(run, pack, decisions.length > 0 ? decisions : pack.repoDecisions);
  const contexts = [contextSnapshotFromPack(run.id, pack, decisions)];
  await replaceAgentActions(env, run.id, actions);
  await persistAgentContextSnapshot(env, contexts[0]!);
  await updateAgentRun(env, run.id, {
    status: "completed",
    dataQualityStatus: pack.dataQuality.signalFidelity.status,
    payload: { ...run.payload, generatedAt: pack.generatedAt, actionCount: actions.length },
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
  const [github, contributorPullRequests, contributorIssues, repositories, syncStates, cachedRepoStats, gittensorSnapshot, repo, issues, pullRequests, recentMergedPullRequests, scoringSnapshot] =
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
      getOrCreateScoringModelSnapshot(env),
    ]);
  const repoStats = contributorRepoStatsFromGittensor(gittensorSnapshot).length > 0 ? contributorRepoStatsFromGittensor(gittensorSnapshot) : cachedRepoStats;
  const profile = buildContributorProfile(input.login, github, contributorPullRequests, contributorIssues, repoStats, gittensorSnapshot);
  const outcomeHistory = buildContributorOutcomeHistory({ login: input.login, profile, repositories, pullRequests: contributorPullRequests, issues: contributorIssues, repoStats });
  const fit = buildContributorFit(profile, repositories, [], [], syncStates, repoStats);
  const scoringProfile = buildContributorScoringProfile({ login: input.login, fit, scoringSnapshot });
  return buildLocalBranchAnalysis({
    input,
    repo,
    issues,
    pullRequests,
    recentMergedPullRequests,
    profile,
    outcomeHistory,
    scoringSnapshot,
    scoringProfile,
  });
}

function buildDecisionActions(run: AgentRunRecord, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentActionRecord[] {
  const decisionByRepo = new Map(decisions.map((decision) => [decision.repoFullName, decision]));
  const candidateActions = pack.topActions
    .filter((action) => decisionByRepo.has(action.repoFullName))
    .slice(0, 8)
    .map((action, index) => actionFromDecisionAction(run, action, decisionByRepo.get(action.repoFullName)!, index));
  if (candidateActions.length > 0) return candidateActions;
  return decisions.slice(0, 5).map((decision, index) => actionFromRepoDecision(run, decision, index));
}

function buildBlockerActions(run: AgentRunRecord, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentActionRecord[] {
  const selected = decisions.length > 0 ? decisions : pack.repoDecisions.filter((decision) => decision.scoreBlockers.length > 0).slice(0, 6);
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
    }),
  );
}

function buildLocalBranchActions(run: AgentRunRecord, analysis: LocalBranchAnalysis): AgentActionRecord[] {
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
    }),
    localPrPacketAction(run, analysis, 1),
  ];
  if (analysis.scoreBlockers.length > 0 || analysis.accountStateBlockers.length > 0) actions.push(...buildLocalBlockerActions(run, analysis, 2));
  return actions.slice(0, 8);
}

function buildLocalBlockerActions(run: AgentRunRecord, analysis: LocalBranchAnalysis, startIndex = 0): AgentActionRecord[] {
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
    }),
  ];
}

function localPrPacketAction(run: AgentRunRecord, analysis: LocalBranchAnalysis, index = 0): AgentActionRecord {
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
    safetyClass: "public_safe",
    approvalRequired: false,
  });
}

function actionFromDecisionAction(run: AgentRunRecord, action: DecisionAction, decision: RepoDecision, index: number): AgentActionRecord {
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
    publicSafeSummary: sanitizePublicSummary(`${decision.repoFullName}: ${action.nextActions[0] ?? "Use Gittensory preflight before posting public PR context."}`),
    payload: {
      action: action as unknown as JsonValue,
      decision: decision as unknown as JsonValue,
    },
  });
}

function actionFromRepoDecision(run: AgentRunRecord, decision: RepoDecision, index: number): AgentActionRecord {
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
    publicSafeSummary: sanitizePublicSummary(`${decision.repoFullName}: ${decision.nextActions[0] ?? "Use local branch preflight before posting."}`),
    payload: { decision: decision as unknown as JsonValue },
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
}): AgentActionRecord {
  return {
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
    payload: args.payload,
    createdAt: nowIso(),
  };
}

function contextSnapshotFromPack(runId: string, pack: ContributorDecisionPack, decisions: RepoDecision[]): AgentContextSnapshotRecord {
  const fidelity = pack.dataQuality.signalFidelity;
  const warnings = [
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
      dataQuality: pack.dataQuality as unknown as JsonValue,
    },
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
  if (action.actionKind === "cleanup_existing_prs") return "Clean up existing PR pressure before opening new work.";
  if (action.actionKind === "land_existing_prs") return "Focus on landing or closing already-open PRs.";
  if (action.actionKind === "file_issue_discovery") return "Only file an actionable, non-duplicate issue-discovery report.";
  if (decision.recommendation === "maintainer_lane") return "Treat this as maintainer-lane repo health work, not outside-contributor work.";
  return action.nextActions[0] ?? "Pick narrow work and run branch preflight before opening a PR.";
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
  buildBlockerActions,
  buildLocalBranchActions,
  buildLocalBlockerActions,
  localPrPacketAction,
  actionFromDecisionAction,
  actionFromRepoDecision,
  actionRecord,
  contextSnapshotFromPack,
  buildRunRecord,
  mapDecisionAction,
  recommendationText,
  maintainerImpactFor,
  rerunWhenForDecision,
  summarizeRun,
  sanitizePublicSummary,
  jsonPayload,
  sameRepo,
};
