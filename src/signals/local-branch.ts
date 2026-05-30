import type { ScorePreviewInput, ScorePreviewResult } from "../scoring/preview";
import { buildScorePreview } from "../scoring/preview";
import type { IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../types";
import { nowIso } from "../utils/json";
import {
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildRepoFitRecommendation,
  buildRoleContext,
  type ContributorOutcomeHistory,
  type ContributorProfile,
  type ContributorScoringProfile,
  type IssueQualityReport,
  type LocalDiffPreflightResult,
  type RoleContext,
} from "./engine";
import { buildRepoRewardRisk, type RepoRewardRisk, type RewardRiskAction } from "./reward-risk";

export type LocalBranchChangedFile = {
  path: string;
  previousPath?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown" | undefined;
  binary?: boolean | undefined;
};

export type LocalBranchValidation = {
  command: string;
  status: "passed" | "failed" | "not_run";
  summary?: string | undefined;
};

export type LocalBranchScorer = {
  mode: "metadata_only" | "external_command" | "gittensor_root";
  activeModel?: string | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  warnings?: string[] | undefined;
};

export type LocalBranchAnalysisInput = {
  login: string;
  repoFullName: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  branchName?: string | undefined;
  baseSha?: string | undefined;
  headSha?: string | undefined;
  mergeBaseSha?: string | undefined;
  remoteTrackingSha?: string | undefined;
  commitMessages?: string[] | undefined;
  changedFiles?: LocalBranchChangedFile[] | undefined;
  validation?: LocalBranchValidation[] | undefined;
  linkedIssues?: number[] | undefined;
  labels?: string[] | undefined;
  title?: string | undefined;
  body?: string | undefined;
  localScorer?: LocalBranchScorer | undefined;
  pendingMergedPrCount?: number | undefined;
  pendingClosedPrCount?: number | undefined;
  approvedPrCount?: number | undefined;
  expectedOpenPrCountAfterMerge?: number | undefined;
  projectedCredibility?: number | undefined;
  scenarioNotes?: string[] | undefined;
};

type ObservedPullRequestScenarios = {
  approvedOrMergeable: number;
  stale: number;
  closed: number;
  draft: number;
  blocked: number;
  maintainerLane: number;
  notes: string[];
};

export type LocalBranchAnalysis = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  branchName?: string | undefined;
  baseFreshness: {
    status: "fresh" | "stale" | "possibly_stale" | "unknown";
    baseRef?: string | undefined;
    baseSha?: string | undefined;
    headSha?: string | undefined;
    mergeBaseSha?: string | undefined;
    remoteTrackingSha?: string | undefined;
    changedFileCount: number;
    testFileCount: number;
    passedValidationCount: number;
    warnings: string[];
    recommendation?: string | undefined;
  };
  lane: ReturnType<typeof buildLaneAdvice>;
  roleContext: RoleContext;
  preflight: LocalDiffPreflightResult;
  scorePreview: ScorePreviewResult;
  scenarioScorePreview: {
    current: ScorePreviewResult["scenarioPreviews"][number];
    bestReasonableCase: ScorePreviewResult["scenarioPreviews"][number];
    afterPendingMerges?: ScorePreviewResult["scenarioPreviews"][number] | undefined;
    afterApprovedPrsMerge?: ScorePreviewResult["scenarioPreviews"][number] | undefined;
    afterStalePrsClose?: ScorePreviewResult["scenarioPreviews"][number] | undefined;
    gateDeltas: ScorePreviewResult["gateDeltas"];
    blockedBy: ScorePreviewResult["blockedBy"];
  };
  observedPullRequestScenarios: ObservedPullRequestScenarios;
  rewardRisk: RepoRewardRisk;
  scoreBlockers: string[];
  branchQualityBlockers: string[];
  accountStateBlockers: string[];
  recommendedRerunCondition: string;
  localFindings: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
    action?: string | undefined;
  }>;
  maintainerFit: {
    recommendation: ReturnType<typeof buildRepoFitRecommendation>["recommendation"];
    reviewBurden: LocalDiffPreflightResult["reviewBurden"];
    role: RoleContext["role"];
    maintainerLane: boolean;
    reasons: string[];
    risks: string[];
  };
  prPacket: {
    titleSuggestion: string;
    markdown: string;
    bodySections: Array<{ heading: string; lines: string[] }>;
    reviewerNotes: string[];
    validationSummary: {
      passed: number;
      failed: number;
      notRun: number;
      commands: LocalBranchValidation[];
    };
    publicSafeWarnings: string[];
  };
  nextActions: RewardRiskAction[];
  summary: string;
};

export function buildLocalBranchAnalysis(args: {
  input: LocalBranchAnalysisInput;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  contributorPullRequests?: PullRequestRecord[] | undefined;
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  repositories?: RepositoryRecord[] | undefined;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  scoringSnapshot: ScoringModelSnapshotRecord;
  scoringProfile?: ContributorScoringProfile | null | undefined;
  issueQuality?: IssueQualityReport | null | undefined;
}): LocalBranchAnalysis {
  const changedFiles = args.input.changedFiles ?? [];
  const changedPaths = changedFiles.map((file) => file.path);
  const testFiles = changedPaths.filter(isTestFile);
  const changedLineCount = changedFiles.reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const commitMessage = (args.input.commitMessages ?? []).join("\n\n").trim();
  const title = args.input.title?.trim() || titleFromBranch(args.input.branchName) || firstCommitTitle(args.input.commitMessages) || "Local branch preflight";
  const preflight = buildLocalDiffPreflightResult(
    {
      repoFullName: args.input.repoFullName,
      contributorLogin: args.input.login,
      title,
      body: args.input.body,
      labels: args.input.labels,
      changedFiles: changedPaths,
      linkedIssues: args.input.linkedIssues,
      tests: validationEvidence(args.input.validation),
      commitMessage,
      changedLineCount,
      testFiles,
    },
    args.repo,
    args.issues,
    args.pullRequests,
    args.issueQuality,
  );
  const roleContext = buildRoleContext({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    pullRequests: args.pullRequests,
    issues: args.issues,
    profile: args.profile,
  });
  const lane = buildLaneAdvice(args.repo, args.input.repoFullName);
  const repoOutcome = args.outcomeHistory.repoOutcomes.find((outcome) => sameRepo(outcome.repoFullName, args.input.repoFullName));
  const observedPullRequestScenarios = buildObservedPullRequestScenarios({
    login: args.input.login,
    repoFullName: args.input.repoFullName,
    pullRequests: args.contributorPullRequests ?? args.pullRequests,
    repositories: args.repositories,
  });
  const scoreInput = buildLocalScoreInput({
    input: args.input,
    changedFiles,
    changedLineCount,
    testFiles,
    linkedIssueCount: preflight.linkedIssues.length,
    roleContext,
    outcomeHistory: args.outcomeHistory,
    repoOutcome,
    observedPullRequestScenarios,
  });
  const scorePreview = buildScorePreview({
    input: scoreInput,
    repo: args.repo,
    snapshot: args.scoringSnapshot,
  });
  const validationSummary = summarizeValidation(args.input.validation ?? []);
  const baseFreshness = buildBaseFreshness(args.input, changedFiles.length, testFiles.length, validationSummary.passed);
  const rewardRisk = buildRepoRewardRisk({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    scoringSnapshot: args.scoringSnapshot,
    scoringProfile: args.scoringProfile,
    issues: args.issues,
    pullRequests: args.pullRequests,
    recentMergedPullRequests: args.recentMergedPullRequests ?? [],
  });
  const recommendation = buildRepoFitRecommendation({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    issues: args.issues,
    pullRequests: args.pullRequests,
  });
  const localFindings = buildLocalFindings(args.input, changedFiles, preflight, scorePreview, baseFreshness);
  const branchQualityBlockers = branchQualityBlockersFor(preflight, localFindings);
  const accountStateBlockers = accountStateBlockersFor(scorePreview);
  const currentScenario = scorePreview.scenarioPreviews.find((scenario) => scenario.name === "current") ?? scorePreview.scenarioPreviews[0]!;
  const bestReasonableScenario = scorePreview.scenarioPreviews.find((scenario) => scenario.name === "bestReasonableCase") ?? currentScenario;
  const scenarioScorePreview = {
    current: currentScenario,
    bestReasonableCase: bestReasonableScenario,
    afterPendingMerges: scorePreview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges"),
    afterApprovedPrsMerge: scorePreview.scenarioPreviews.find((scenario) => scenario.name === "afterApprovedPrsMerge"),
    afterStalePrsClose: scorePreview.scenarioPreviews.find((scenario) => scenario.name === "afterStalePrsClose"),
    gateDeltas: scorePreview.gateDeltas,
    blockedBy: scorePreview.blockedBy,
  };
  const recommendedRerunCondition = recommendedRerunFor(baseFreshness, branchQualityBlockers, accountStateBlockers, scorePreview);
  const prPacket = buildPublicSafePrPacket({
    title,
    preflight,
    changedFiles,
    validationSummary,
    roleContext,
    laneSummary: lane.summary,
    localFindings,
    baseFreshness,
    recommendedRerunCondition,
  });
  const scoreBlockers = [
    ...rewardRisk.scoreBlockers,
    ...scorePreview.warnings.filter((warning) => /not registered|no active|exceeds|credibility|token gate/i.test(warning)),
    ...preflight.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.title),
  ];
  return {
    login: args.input.login,
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    baseRef: args.input.baseRef,
    headRef: args.input.headRef,
    branchName: args.input.branchName,
    baseFreshness,
    lane,
    roleContext,
    preflight,
    scorePreview,
    scenarioScorePreview,
    observedPullRequestScenarios,
    rewardRisk,
    scoreBlockers: [...new Set(scoreBlockers)],
    branchQualityBlockers,
    accountStateBlockers,
    recommendedRerunCondition,
    localFindings,
    maintainerFit: {
      recommendation: recommendation.recommendation,
      reviewBurden: preflight.reviewBurden,
      role: roleContext.role,
      maintainerLane: roleContext.maintainerLane,
      reasons: recommendation.reasons,
      risks: recommendation.risks,
    },
    prPacket,
    nextActions: withSituationalAction(rewardRisk.actions, branchQualityBlockers, accountStateBlockers, scorePreview).slice(0, 6),
    summary: `${args.input.repoFullName}: local branch analysis is ${preflight.status}; ${rewardRisk.actions[0]?.actionKind ?? "no ranked action"} is the top private next action.`,
  };
}

function buildLocalScoreInput(args: {
  input: LocalBranchAnalysisInput;
  changedFiles: LocalBranchChangedFile[];
  changedLineCount: number;
  testFiles: string[];
  linkedIssueCount: number;
  roleContext: RoleContext;
  outcomeHistory: ContributorOutcomeHistory;
  repoOutcome?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  observedPullRequestScenarios: ObservedPullRequestScenarios;
}): ScorePreviewInput {
  const scorer = args.input.localScorer;
  const testLineCount = args.changedFiles.filter((file) => isTestFile(file.path)).reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const sourceLineCount = args.changedFiles
    .filter((file) => isCodeFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const nonCodeLineCount = Math.max(0, args.changedLineCount - sourceLineCount - testLineCount);
  return {
    repoFullName: args.input.repoFullName,
    targetType: "local_diff",
    targetKey: `${args.input.login}:${args.input.repoFullName}:${args.input.branchName ?? args.input.headRef ?? "local-branch"}`,
    contributorLogin: args.input.login,
    labels: args.input.labels ?? [],
    linkedIssueMode: args.roleContext.maintainerLane ? "maintainer" : args.linkedIssueCount > 0 ? "standard" : "none",
    sourceTokenScore: scorer?.sourceTokenScore ?? Math.max(0, sourceLineCount),
    totalTokenScore: scorer?.totalTokenScore ?? Math.max(0, args.changedLineCount),
    sourceLines: scorer?.sourceLines ?? Math.max(1, sourceLineCount || args.changedLineCount || 1),
    testTokenScore: scorer?.testTokenScore ?? testLineCount,
    nonCodeTokenScore: scorer?.nonCodeTokenScore ?? nonCodeLineCount,
    openPrCount: args.outcomeHistory.totals.openPullRequests,
    credibility: args.repoOutcome?.credibility ?? args.outcomeHistory.totals.credibility,
    metadataOnly: scorer?.mode !== "gittensor_root" && scorer?.mode !== "external_command",
    pendingMergedPrCount: args.input.pendingMergedPrCount,
    pendingClosedPrCount: args.input.pendingClosedPrCount,
    approvedPrCount: args.input.approvedPrCount,
    observedApprovedPrCount: args.observedPullRequestScenarios.approvedOrMergeable,
    observedStalePrCount: args.observedPullRequestScenarios.stale,
    observedClosedPrCount: args.observedPullRequestScenarios.closed,
    observedDraftPrCount: args.observedPullRequestScenarios.draft,
    observedBlockedPrCount: args.observedPullRequestScenarios.blocked,
    observedMaintainerPrCount: args.observedPullRequestScenarios.maintainerLane,
    expectedOpenPrCountAfterMerge: args.input.expectedOpenPrCountAfterMerge,
    projectedCredibility: args.input.projectedCredibility,
    scenarioNotes: args.input.scenarioNotes,
    observedScenarioNotes: args.observedPullRequestScenarios.notes,
  };
}

function buildObservedPullRequestScenarios(args: {
  login: string;
  repoFullName: string;
  pullRequests: PullRequestRecord[];
  repositories?: RepositoryRecord[] | undefined;
  nowMs?: number | undefined;
}): ObservedPullRequestScenarios {
  const repoByName = new Map((args.repositories ?? []).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const registeredRepos = new Set((args.repositories ?? []).filter((repo) => repo.isRegistered).map((repo) => repo.fullName.toLowerCase()));
  const scopedPullRequests = args.pullRequests.filter((pr) => {
    if (!sameLogin(pr.authorLogin, args.login)) return false;
    if (registeredRepos.size > 0) return registeredRepos.has(pr.repoFullName.toLowerCase());
    return sameRepo(pr.repoFullName, args.repoFullName);
  });
  let approvedOrMergeable = 0;
  let stale = 0;
  let closed = 0;
  let draft = 0;
  let blocked = 0;
  let maintainerLane = 0;
  for (const pr of scopedPullRequests) {
    const repo = repoByName.get(pr.repoFullName.toLowerCase());
    if (isMaintainerAuthoredPr(pr, repo, args.login)) {
      maintainerLane += 1;
      continue;
    }
    if (pr.state !== "open") {
      if (pr.state === "closed" && !pr.mergedAt) closed += 1;
      continue;
    }
    if (pr.isDraft) {
      draft += 1;
      continue;
    }
    if (isStaleOpenPr(pr, args.nowMs)) {
      stale += 1;
      continue;
    }
    if (isBlockedOpenPr(pr)) {
      blocked += 1;
      continue;
    }
    if (isApprovedOrMergeableOpenPr(pr)) approvedOrMergeable += 1;
  }
  return {
    approvedOrMergeable,
    stale,
    closed,
    draft,
    blocked,
    maintainerLane,
    notes: observedPullRequestNotes({ approvedOrMergeable, stale, closed, draft, blocked, maintainerLane }),
  };
}

function observedPullRequestNotes(scenarios: Omit<ObservedPullRequestScenarios, "notes">): string[] {
  return [
    ...(scenarios.approvedOrMergeable > 0 ? [`${scenarios.approvedOrMergeable} cached approved or mergeable open PR(s) can be modeled as likely-to-land.`] : []),
    ...(scenarios.stale > 0 ? [`${scenarios.stale} cached stale open PR(s) can be modeled as cleanup-first rather than likely-to-land.`] : []),
    ...(scenarios.closed > 0 ? [`${scenarios.closed} cached already-closed PR(s) are excluded from open PR pressure projections.`] : []),
  ];
}

function isMaintainerAuthoredPr(pr: PullRequestRecord, repo: RepositoryRecord | undefined, login: string): boolean {
  return sameLogin(repo?.owner, login) || ["owner", "member", "collaborator"].includes((pr.authorAssociation ?? "").toLowerCase());
}

function isStaleOpenPr(pr: PullRequestRecord, nowMs: number | undefined): boolean {
  const updatedAt = Date.parse(pr.updatedAt ?? pr.createdAt ?? "");
  return Number.isFinite(updatedAt) && (nowMs ?? Date.now()) - updatedAt >= 14 * 24 * 60 * 60 * 1000;
}

function isBlockedOpenPr(pr: PullRequestRecord): boolean {
  const reviewDecision = (pr.reviewDecision ?? "").toLowerCase();
  const mergeableState = (pr.mergeableState ?? "").toLowerCase();
  return reviewDecision === "changes_requested" || ["blocked", "dirty", "conflicting", "unknown", "unstable"].includes(mergeableState);
}

function isApprovedOrMergeableOpenPr(pr: PullRequestRecord): boolean {
  const reviewDecision = (pr.reviewDecision ?? "").toLowerCase();
  const mergeableState = (pr.mergeableState ?? "").toLowerCase();
  return reviewDecision === "approved" || ["clean", "has_hooks", "mergeable", "mergeable_state_clean"].includes(mergeableState);
}

function buildLocalFindings(
  input: LocalBranchAnalysisInput,
  changedFiles: LocalBranchChangedFile[],
  preflight: LocalDiffPreflightResult,
  scorePreview: ScorePreviewResult,
  baseFreshness: LocalBranchAnalysis["baseFreshness"],
): LocalBranchAnalysis["localFindings"] {
  const failedValidation = (input.validation ?? []).filter((entry) => entry.status === "failed");
  return [
    {
      code: "source_upload_disabled",
      severity: "info" as const,
      title: "Source upload disabled",
      detail: "Local MCP branch analysis used structured git metadata only; source contents were not uploaded.",
    },
    ...(input.repoFullName.toLowerCase() === "jsonbored/gittensory"
      ? [
          {
            code: "gittensory_not_registered",
            severity: "warning" as const,
            title: "Gittensory is not registered",
            detail: "Treat this project as product/maintainer work until it appears in the official registry snapshot.",
            action: "Do not treat this repo as a miner target yet.",
          },
        ]
      : []),
    ...(failedValidation.length > 0
      ? [
          {
            code: "failed_local_validation",
            severity: "warning" as const,
            title: "Local validation failed",
            detail: `${failedValidation.length} validation command(s) were reported as failed.`,
            action: "Fix validation before asking maintainers to review.",
          },
        ]
      : []),
    ...(changedFiles.some((file) => file.binary)
      ? [
          {
            code: "binary_diff_present",
            severity: "info" as const,
            title: "Binary changes detected",
            detail: "Binary file changes cannot be scored or reviewed from line metadata alone.",
          },
        ]
      : []),
    ...(baseFreshness.status === "stale" || baseFreshness.status === "possibly_stale"
      ? [
          {
            code: "stale_base_ref",
            severity: "warning" as const,
            title: "Base ref may be stale",
            detail: baseFreshness.warnings.join(" "),
            action: baseFreshness.recommendation,
          },
        ]
      : []),
    ...scorePreview.warnings.map((warning) => ({
      code: "score_preview_warning",
      severity: /not registered|no active|exceeds|credibility/i.test(warning) ? ("warning" as const) : ("info" as const),
      title: "Private preview warning",
      detail: warning,
    })),
    ...preflight.findings.map((finding) => ({
      code: `preflight_${finding.code}`,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      action: finding.action,
    })),
  ];
}

function buildBaseFreshness(
  input: LocalBranchAnalysisInput,
  changedFileCount: number,
  testFileCount: number,
  passedValidationCount: number,
): LocalBranchAnalysis["baseFreshness"] {
  const warnings: string[] = [];
  if (input.remoteTrackingSha && input.baseSha && input.remoteTrackingSha !== input.baseSha) {
    warnings.push(`Local base ${input.baseRef ?? "base"} is behind remote tracking SHA; current diff has ${changedFileCount} changed file(s).`);
  }
  if (input.mergeBaseSha && input.baseSha && input.mergeBaseSha !== input.baseSha) {
    warnings.push(`Merge-base does not match the selected base ref; current diff has ${changedFileCount} changed file(s).`);
  }
  if (changedFileCount >= 50 && !input.remoteTrackingSha) {
    warnings.push(`Large local diff has ${changedFileCount} changed file(s), but remote base freshness could not be verified.`);
  }
  const status =
    warnings.length === 0 && input.remoteTrackingSha && input.baseSha
      ? "fresh"
      : warnings.some((warning) => /behind remote|Merge-base/i.test(warning))
        ? "stale"
        : warnings.length > 0
          ? "possibly_stale"
          : "unknown";
  return {
    status,
    baseRef: input.baseRef,
    baseSha: input.baseSha,
    headSha: input.headSha,
    mergeBaseSha: input.mergeBaseSha,
    remoteTrackingSha: input.remoteTrackingSha,
    changedFileCount,
    testFileCount,
    passedValidationCount,
    warnings,
    recommendation: warnings.length > 0 ? "Run `git fetch origin` and rerun Gittensory branch analysis against the refreshed base." : undefined,
  };
}

function branchQualityBlockersFor(preflight: LocalDiffPreflightResult, localFindings: LocalBranchAnalysis["localFindings"]): string[] {
  return [
    ...preflight.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.title),
    ...localFindings
      .filter((finding) => finding.severity !== "info" && finding.code !== "score_preview_warning")
      .map((finding) => finding.title),
  ].filter(unique);
}

function accountStateBlockersFor(scorePreview: ScorePreviewResult): string[] {
  return scorePreview.blockedBy
    .filter((blocker) => ["repo_not_registered", "inactive_allocation", "open_pr_threshold", "credibility_floor"].includes(blocker.code))
    .map((blocker) => blocker.detail)
    .filter(unique);
}

function recommendedRerunFor(
  baseFreshness: LocalBranchAnalysis["baseFreshness"],
  branchQualityBlockers: string[],
  accountStateBlockers: string[],
  scorePreview: ScorePreviewResult,
): string {
  if (baseFreshness.status === "stale" || baseFreshness.status === "possibly_stale") return "Run `git fetch origin` and rerun; current diff size may be inflated by stale base state.";
  if (branchQualityBlockers.length > 0) return "Rerun after fixing branch-quality blockers or adding explicit validation/linked-context evidence.";
  const afterPending = scorePreview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
  if (accountStateBlockers.length > 0 && afterPending && afterPending.effectiveEstimatedScore > scorePreview.effectiveEstimatedScore) {
    return `Rerun after pending PRs merge/close or after open PR count is at or below ${afterPending.gates.openPrThreshold}; projected score changes ${scorePreview.effectiveEstimatedScore} -> ${afterPending.effectiveEstimatedScore}.`;
  }
  if (accountStateBlockers.length > 0) return "Rerun after account/queue maturity blockers clear.";
  return "Rerun after any branch, base, or PR state changes before opening/submitting.";
}

function withSituationalAction(
  actions: RewardRiskAction[],
  branchQualityBlockers: string[],
  accountStateBlockers: string[],
  scorePreview: ScorePreviewResult,
): RewardRiskAction[] {
  const afterPending = scorePreview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
  if (branchQualityBlockers.length > 0 || accountStateBlockers.length === 0 || !afterPending || afterPending.effectiveEstimatedScore <= scorePreview.effectiveEstimatedScore) {
    return actions;
  }
  const waitAction: RewardRiskAction = {
    actionKind: "land_existing_prs",
    repoFullName: scorePreview.repoFullName,
    priorityScore: Math.max(95, actions[0]?.priorityScore ?? 0),
    laneValueScore: 0,
    scoreabilityScore: afterPending.effectiveEstimatedScore,
    personalFitScore: 0,
    riskPenalty: 0,
    maintainerFrictionPenalty: 0,
    actionLeverageScore: 100,
    whyThisHelps: [
      `Branch metadata is not the main blocker; waiting for pending PRs to merge/close changes effective score ${scorePreview.effectiveEstimatedScore} -> ${afterPending.effectiveEstimatedScore}.`,
      afterPending.deltaExplanation,
    ],
    nextActions: ["Wait for approved/pending PRs to merge or close, then rerun branch analysis before opening more work."],
  };
  return [waitAction, ...actions];
}

function buildPublicSafePrPacket(args: {
  title: string;
  preflight: LocalDiffPreflightResult;
  changedFiles: LocalBranchChangedFile[];
  validationSummary: LocalBranchAnalysis["prPacket"]["validationSummary"];
  roleContext: RoleContext;
  laneSummary: string;
  localFindings: LocalBranchAnalysis["localFindings"];
  baseFreshness: LocalBranchAnalysis["baseFreshness"];
  recommendedRerunCondition: string;
}): LocalBranchAnalysis["prPacket"] {
  const topPaths = args.changedFiles.slice(0, 8).map(changedFileSummary);
  const publicSafeWarnings = [
    ...(args.roleContext.maintainerLane ? ["This is maintainer-lane context; present it as repo stewardship work."] : []),
    ...args.preflight.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => finding.publicText ?? finding.action ?? finding.title),
    ...args.localFindings
      .filter((finding) => finding.code !== "score_preview_warning" && finding.severity === "warning")
      .flatMap((finding) => (finding.action ? [finding.action] : [finding.title])),
  ].filter(isPublicSafeText);
  const nextSteps = [...publicSafeWarnings, args.baseFreshness.recommendation, args.recommendedRerunCondition, "Keep source upload disabled; this packet is based on local git metadata only."].filter(
    (line): line is string => Boolean(line && isPublicSafeText(line)),
  );
  const validationLines =
    args.validationSummary.commands.length > 0
      ? args.validationSummary.commands.map((entry) => `- ${entry.status}: ${entry.command}${entry.summary ? ` (${entry.summary})` : ""}`)
      : ["- Not supplied yet."];
  const bodySections = [
      {
        heading: "Summary",
        lines: ["Describe the user-visible problem or maintainer-facing improvement this branch addresses."],
      },
      {
        heading: "Linked Context",
        lines: args.preflight.linkedIssues.length > 0 ? args.preflight.linkedIssues.map((issue) => `- Closes #${issue}`) : ["- No linked issue detected; explain why this is a no-issue PR."],
      },
      { heading: "Branch Freshness", lines: branchFreshnessLines(args.baseFreshness) },
      { heading: "Overlap/WIP Check", lines: overlapCautionLines(args.preflight.collisions) },
      {
        heading: "Changed Paths",
        lines: topPaths.length > 0 ? topPaths.map((path) => `- ${path}`) : ["- No changed paths were detected from local metadata."],
      },
      {
        heading: "Validation",
        lines: validationLines,
      },
      { heading: "Next Steps", lines: [...new Set(nextSteps)].slice(0, 6).map((line) => `- ${line.replace(/^- /, "")}`) },
    ];
  return {
    titleSuggestion: args.title,
    markdown: renderPrPacketMarkdown(args.title, bodySections),
    bodySections,
    reviewerNotes: [
      `Lane context: ${args.laneSummary}`,
      `Review burden: ${args.preflight.reviewBurden}`,
      `Role context: ${args.roleContext.role}${args.roleContext.maintainerLane ? " (maintainer lane)" : ""}`,
    ],
    validationSummary: args.validationSummary,
    publicSafeWarnings: [...new Set(publicSafeWarnings)],
  };
}

function branchFreshnessLines(freshness: LocalBranchAnalysis["baseFreshness"]): string[] {
  return [`- Base freshness: ${freshness.status}.`, ...freshness.warnings.filter(isPublicSafeText).map((warning) => `- ${warning}`), freshness.passedValidationCount > 0 ? `- Validation evidence supplied: ${freshness.passedValidationCount} passed command(s).` : "- No passed validation evidence was supplied."];
}

function overlapCautionLines(collisions: LocalDiffPreflightResult["collisions"]): string[] {
  if (collisions.length === 0) return ["- No active overlap or WIP was detected from cached issue/PR metadata."];
  return collisions
    .slice(0, 3)
    .map((cluster) => `- Possible overlap or WIP (${cluster.risk}): ${cluster.reason} Check ${cluster.items.slice(0, 3).map((item) => `${item.type === "pull_request" ? "PR" : item.type === "issue" ? "issue" : "merged PR"} #${item.number}`).join(", ")} before posting.`)
    .filter(isPublicSafeText);
}

function changedFileSummary(file: LocalBranchChangedFile): string {
  return `${file.previousPath ? `${safeRepoPath(file.previousPath)} -> ${safeRepoPath(file.path)}` : safeRepoPath(file.path)} (${file.status ?? "modified"}, ${file.binary ? "binary" : `+${nonNegative(file.additions)}/-${nonNegative(file.deletions)}`})`;
}

function renderPrPacketMarkdown(title: string, sections: Array<{ heading: string; lines: string[] }>): string {
  return `${[`# ${title}`, ...sections.flatMap((section) => ["", `## ${section.heading}`, ...section.lines])].filter(isPublicSafeText).join("\n").trim()}\n`;
}

function summarizeValidation(validation: LocalBranchValidation[]): LocalBranchAnalysis["prPacket"]["validationSummary"] {
  return {
    passed: validation.filter((entry) => entry.status === "passed").length,
    failed: validation.filter((entry) => entry.status === "failed").length,
    notRun: validation.filter((entry) => entry.status === "not_run").length,
    commands: validation,
  };
}

function validationEvidence(validation: LocalBranchValidation[] | undefined): string[] {
  return (validation ?? [])
    .filter((entry) => entry.status === "passed")
    .map((entry) => entry.command);
}

function titleFromBranch(branchName: string | undefined): string | undefined {
  const cleaned = branchName?.replace(/^[-/_.\w]+\/(?=[^/]+$)/, "").replace(/[-_]+/g, " ").trim();
  return cleaned || undefined;
}

function firstCommitTitle(messages: string[] | undefined): string | undefined {
  return messages?.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim() || undefined;
}

function isPublicSafeText(text: string): boolean {
  return !/\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:\\Users\\/i.test(text);
}

function safeRepoPath(path: string): string {
  return /^(\/Users\/|\/home\/|\/tmp\/|[A-Z]:\/Users\/)/i.test(String(path).replace(/\\/g, "/")) ? "[local path hidden]" : String(path || "(unknown path)").replace(/\\/g, "/");
}

function isTestFile(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file)
  );
}

function isCodeFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function unique<T>(value: T, index: number, values: T[]): boolean {
  return values.indexOf(value) === index;
}
