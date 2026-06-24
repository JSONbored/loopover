import type { BranchEligibilityInput, BranchEligibilityResult, LinkedIssueMultiplierContext, ScorePreviewInput, ScorePreviewResult } from "../scoring/preview";
import { buildScorePreview } from "../scoring/preview";
import type { GittensorContributorSnapshot } from "../gittensor/api";
import type { BountyRecord, CheckSummaryRecord, IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../types";
import { nowIso } from "../utils/json";
import {
  buildCollisionReport,
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildQueueHealth,
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
import { buildLocalWorkspaceIntelligence, type LocalWorkspaceIntelligence } from "./local-workspace-intelligence";
import { buildFocusManifestGuidance, parseFocusManifest, type FocusManifestGuidance } from "./focus-manifest";
import { sanitizeLocalScorerWarnings } from "./local-scorer-diagnostics";
import { isPublicSafeText } from "./redaction";
import { deriveEligibilityPlan } from "../services/eligibility-plan";
import { scenarioInputFromLocalBranchMetadata } from "../scenarios/input-model";
import { renderPublicScenarioSummary, type PublicScenarioSummary, type ScenarioSummaryInput } from "../scenarios/scenario-summary";
import { simulateOpenPrPressure } from "../services/open-pr-pressure-scenarios";
import { isTestPath } from "./test-evidence";

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
  status: "passed" | "failed" | "not_run" | "skipped" | "focused" | "unknown";
  summary?: string | undefined;
  durationMs?: number | undefined;
  exitCode?: number | undefined;
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
  pendingCommitCount?: number | undefined;
  ciStatusHints?: string[] | undefined;
  focusManifest?: unknown;
  branchEligibility?: BranchEligibilityInput | undefined;
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

type GitHubBranchStatus = {
  source: "cached_github_data";
  status: "approved" | "failing_checks" | "needs_author" | "blocked" | "pending_review" | "no_pr" | "unknown";
  pullNumber?: number | undefined;
  title?: string | undefined;
  reviewDecision?: string | null | undefined;
  mergeableState?: string | null | undefined;
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
  githubBranchStatus: GitHubBranchStatus;
  branchEligibility: BranchEligibilityResult;
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
  manifestGuidance: FocusManifestGuidance;
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
  workspaceIntelligence: LocalWorkspaceIntelligence;
  scenarioSummary: PublicScenarioSummary;
  summary: string;
};

export function buildLocalBranchAnalysis(args: {
  input: LocalBranchAnalysisInput;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  contributorPullRequests?: PullRequestRecord[] | undefined;
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  bounties?: BountyRecord[] | undefined;
  repositories?: RepositoryRecord[] | undefined;
  checkSummaries?: CheckSummaryRecord[] | undefined;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  scoringSnapshot: ScoringModelSnapshotRecord;
  scoringProfile?: ContributorScoringProfile | null | undefined;
  issueQuality?: IssueQualityReport | null | undefined;
  gittensorSnapshot?: GittensorContributorSnapshot | null | undefined;
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
    args.bounties ?? [],
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
  const githubBranchStatus = buildGitHubBranchStatus(args.input, args.pullRequests, args.checkSummaries ?? []);
  const linkedIssueContext = buildLinkedIssueMultiplierContext({
    repoFullName: args.input.repoFullName,
    linkedIssues: preflight.linkedIssues,
    issueQuality: args.issueQuality,
    gittensorSnapshot: args.gittensorSnapshot,
  });
  const scoreInput = buildLocalScoreInput({
    input: args.input,
    changedFiles,
    changedLineCount,
    testFiles,
    linkedIssueCount: preflight.linkedIssues.length,
    linkedIssueContext,
    roleContext,
    outcomeHistory: args.outcomeHistory,
    repoOutcome,
    observedPullRequestScenarios,
    duplicateRiskCount: preflight.collisions.filter((cluster) => cluster.risk === "high").length,
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
  const manifest = parseFocusManifest(args.input.focusManifest);
  const manifestGuidance = buildFocusManifestGuidance({
    manifest,
    changedPaths,
    labels: args.input.labels,
    linkedIssueCount: preflight.linkedIssues.length,
    testFileCount: testFiles.length,
    passedValidationCount: validationSummary.passed,
  });
  const localFindings = [
    ...buildLocalFindings(args.input, changedFiles, preflight, scorePreview, baseFreshness, githubBranchStatus, scorePreview.branchEligibility),
    ...manifestGuidance.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      action: finding.action,
    })),
  ];
  const branchQualityBlockers = branchQualityBlockersFor(preflight, localFindings);
  const accountStateBlockers = accountStateBlockersFor(scorePreview);
  /* v8 ignore next -- buildScorePreview always emits a current scenario; this fallback protects malformed scorer adapters. */
  const currentScenario = scorePreview.scenarioPreviews.find((scenario) => scenario.name === "current") ?? scorePreview.scenarioPreviews[0]!;
  /* v8 ignore next -- buildScorePreview always emits bestReasonableCase; current is the defensive adapter fallback. */
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
  const recommendedRerunCondition = recommendedRerunFor(baseFreshness, branchQualityBlockers, accountStateBlockers, scorePreview, scorePreview.branchEligibility);
  const prPacket = buildPublicSafePrPacket({
    title,
    preflight,
    changedFiles,
    validationSummary,
    roleContext,
    laneSummary: lane.summary,
    localFindings,
    baseFreshness,
    githubBranchStatus,
    branchEligibility: scorePreview.branchEligibility,
    recommendedRerunCondition,
    manifestGuidance,
  });
  const scoreBlockers = [
    ...rewardRisk.scoreBlockers,
    ...scorePreview.warnings.filter((warning) => /not registered|no active|exceeds|credibility|token gate|confirmed ineligible/i.test(warning)),
    ...preflight.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.title),
  ];
  const eligibilityPlan = deriveEligibilityPlan(scorePreview);
  const eligibilityStatusForScenario = scorePreview.branchEligibility.status === "not_required" ? undefined : scorePreview.branchEligibility.status;
  const branchScenarioInput = scenarioInputFromLocalBranchMetadata({
    scenarioType: "branch_preflight",
    login: args.input.login,
    repoFullName: args.input.repoFullName,
    ...(args.input.branchName ? { branchName: args.input.branchName } : {}),
    ...(args.input.baseRef ? { baseRef: args.input.baseRef } : {}),
    changedFileCount: changedFiles.length,
    ...(args.input.linkedIssues ? { linkedIssues: args.input.linkedIssues } : {}),
    scenarioNotes: observedPullRequestScenarios.notes.slice(0, 4),
    ...(eligibilityStatusForScenario ? { eligibilityStatus: eligibilityStatusForScenario } : {}),
  });
  // classified is intentionally empty here: buildLocalBranchAnalysis only has aggregate
  // counts and notes from observedPullRequestScenarios, not per-PR detail rows. The
  // pendingScenarioNotes surface the counts; per-PR rows require caller-supplied classification.
  const pendingDetectionForSummary: ScenarioSummaryInput["pendingDetection"] =
    observedPullRequestScenarios.approvedOrMergeable > 0 || observedPullRequestScenarios.stale > 0
      ? {
          source: "github_observed",
          pendingMergedPrCount: observedPullRequestScenarios.approvedOrMergeable,
          pendingClosedPrCount: observedPullRequestScenarios.stale,
          approvedPrCount: observedPullRequestScenarios.approvedOrMergeable,
          scenarioNotes: observedPullRequestScenarios.notes,
          classified: [],
        }
      : undefined;
  // Open-PR pressure strategy options (#348): the scenario summary renderer fills its strategy
  // `options` (open new work / wait / clean up first) and headline from this simulation. Without
  // passing it, scenarioSummary.options was always empty and the guidance never reached the miner.
  const queuePressureSimulation = simulateOpenPrPressure({
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    queueHealth: buildQueueHealth(args.repo, args.issues, args.pullRequests, buildCollisionReport(args.input.repoFullName, args.issues, args.pullRequests)),
    roleContext,
    contributorOpenPrCount: (args.contributorPullRequests ?? args.pullRequests).filter(
      (pr) => sameRepo(pr.repoFullName, args.input.repoFullName) && pr.state === "open" && (pr.authorLogin ?? "").toLowerCase() === args.input.login.toLowerCase(),
    ).length,
  });
  const scenarioSummary = renderPublicScenarioSummary({
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    eligibilityPlan,
    publicBlockers: scorePreview.blockedBy,
    scenarioInput: branchScenarioInput,
    pendingDetection: pendingDetectionForSummary,
    pressureSimulation: queuePressureSimulation,
  });
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
    githubBranchStatus,
    branchEligibility: scorePreview.branchEligibility,
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
    manifestGuidance,
    prPacket,
    nextActions: withSituationalAction(rewardRisk.actions, branchQualityBlockers, accountStateBlockers, scorePreview).slice(0, 6),
    scenarioSummary,
    workspaceIntelligence: buildLocalWorkspaceIntelligence({
      input: args.input,
      analysis: {
        baseFreshness,
        branchQualityBlockers,
        accountStateBlockers,
        recommendedRerunCondition,
        prPacket,
      },
      changedFiles,
    }),
    summary: `${args.input.repoFullName}: local branch analysis is ${preflight.status}; ${rewardRisk.actions[0]?.actionKind ?? "no ranked action"} is the top private next action.`,
  };
}

function buildLocalScoreInput(args: {
  input: LocalBranchAnalysisInput;
  changedFiles: LocalBranchChangedFile[];
  changedLineCount: number;
  testFiles: string[];
  linkedIssueCount: number;
  linkedIssueContext?: LinkedIssueMultiplierContext | undefined;
  roleContext: RoleContext;
  outcomeHistory: ContributorOutcomeHistory;
  repoOutcome?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
  observedPullRequestScenarios: ObservedPullRequestScenarios;
  duplicateRiskCount: number;
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
    linkedIssueContext: args.linkedIssueContext,
    sourceTokenScore: scorer?.sourceTokenScore ?? Math.max(0, sourceLineCount),
    totalTokenScore: scorer?.totalTokenScore ?? Math.max(0, args.changedLineCount),
    sourceLines: scorer?.sourceLines ?? Math.max(1, sourceLineCount || args.changedLineCount || 1),
    testTokenScore: scorer?.testTokenScore ?? testLineCount,
    nonCodeTokenScore: scorer?.nonCodeTokenScore ?? nonCodeLineCount,
    nonCodeLines: nonCodeLineCount,
    openPrCount: args.outcomeHistory.totals.openPullRequests,
    openIssueCount: args.repoOutcome?.openIssues ?? args.outcomeHistory.totals.openIssues,
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
    duplicateRiskCount: args.duplicateRiskCount,
    expectedOpenPrCountAfterMerge: args.input.expectedOpenPrCountAfterMerge,
    projectedCredibility: args.input.projectedCredibility,
    scenarioNotes: args.input.scenarioNotes,
    observedScenarioNotes: args.observedPullRequestScenarios.notes,
    branchEligibility: args.input.branchEligibility,
  };
}

function buildLinkedIssueMultiplierContext(args: {
  repoFullName: string;
  linkedIssues: number[];
  issueQuality?: IssueQualityReport | null | undefined;
  gittensorSnapshot?: GittensorContributorSnapshot | null | undefined;
}): LinkedIssueMultiplierContext | undefined {
  const issueNumbers = uniquePositiveInts(args.linkedIssues);
  if (issueNumbers.length === 0) return undefined;
  const mirror = linkedIssueContextFromMirror(args.repoFullName, issueNumbers, args.gittensorSnapshot);
  if (mirror.context) return mirror.context;
  const github = linkedIssueContextFromIssueQuality(issueNumbers, args.issueQuality);
  if (github) {
    return {
      ...github,
      warnings: [...new Set([...mirror.warnings, ...(github.warnings ?? [])])],
    };
  }
  return {
    status: "unavailable",
    source: "missing",
    issueNumbers,
    solvedByPullRequests: [],
    reason: `Linked issue mirror/cache data is unavailable for ${issueNumbers.map((number) => `#${number}`).join(", ")}.`,
    warnings: mirror.warnings,
  };
}

function linkedIssueContextFromMirror(
  repoFullName: string,
  issueNumbers: number[],
  snapshot: GittensorContributorSnapshot | null | undefined,
): { context?: LinkedIssueMultiplierContext | undefined; warnings: string[] } {
  if (!snapshot) return { warnings: ["Official mirror data is unavailable for this contributor; using cached GitHub linkage if present."] };
  if (snapshot.issueMirrorAvailable === false) return { warnings: ["Official mirror issue data is unavailable; using cached GitHub linkage if present."] };
  const issues = (snapshot.issues ?? []).filter((issue) => sameRepo(issue.repoFullName, repoFullName) && issueNumbers.includes(issue.number));
  if (issues.length === 0) return { warnings: ["Official mirror has no matching solved_by_pr row for the linked issue(s); using cached GitHub linkage if present."] };
  const solvedByPullRequests = uniquePositiveInts(issues.flatMap((issue) => (issue.solvedByPullRequest ? [issue.solvedByPullRequest] : [])));
  const missingIssues = issueNumbers.filter((number) => !issues.some((issue) => issue.number === number));
  const closedWithoutSolver = issues.filter((issue) => issue.state.toLowerCase() !== "open" && !issue.solvedByPullRequest).map((issue) => issue.number);
  const status: NonNullable<LinkedIssueMultiplierContext["status"]> =
    solvedByPullRequests.length > 0 ? "validated" : closedWithoutSolver.length > 0 ? "invalid" : "raw";
  const reason =
    status === "validated"
      ? `Official mirror solved_by_pr validates linked issue(s) ${issues.map((issue) => `#${issue.number}`).join(", ")} via PR ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}.`
      : status === "invalid"
        ? `Official mirror has closed linked issue(s) without solved_by_pr evidence: ${closedWithoutSolver.map((number) => `#${number}`).join(", ")}.`
        : `Official mirror has linked issue row(s) for ${issues.map((issue) => `#${issue.number}`).join(", ")}, but no solved_by_pr evidence yet.`;
  return {
    context: {
      status,
      source: "official_mirror",
      issueNumbers,
      solvedByPullRequests,
      reason,
      warnings: [
        ...(status === "raw" ? ["Official mirror issue row exists, but solved_by_pr is not set yet."] : []),
        ...(missingIssues.length > 0 ? [`Official mirror did not include linked issue(s): ${missingIssues.map((number) => `#${number}`).join(", ")}.`] : []),
      ],
    },
    warnings: [],
  };
}

function linkedIssueContextFromIssueQuality(issueNumbers: number[], issueQuality: IssueQualityReport | null | undefined): LinkedIssueMultiplierContext | undefined {
  if (!issueQuality) return undefined;
  const byIssue = new Map(issueQuality.issues.map((issue) => [issue.number, issue]));
  const entries = issueNumbers.map((number) => byIssue.get(number)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (entries.length === 0) return undefined;
  const solvedByPullRequests = uniquePositiveInts(entries.flatMap((entry) => entry.linkage?.solvedByPullRequests ?? []));
  const invalid = entries.filter((entry) => entry.linkage?.status === "invalid" || (entry.status === "do_not_use" && entry.linkage?.status !== "validated"));
  const plausible = entries.filter((entry) => entry.linkage?.status === "plausible");
  const raw = entries.filter((entry) => entry.linkage?.status === "raw" || !entry.linkage);
  const missingIssues = issueNumbers.filter((number) => !byIssue.has(number));
  const status: NonNullable<LinkedIssueMultiplierContext["status"]> =
    invalid.length > 0 ? "invalid" : solvedByPullRequests.length > 0 ? "validated" : plausible.length > 0 ? "plausible" : raw.length > 0 ? "raw" : "unavailable";
  const reason =
    status === "validated"
      ? `Cached issue-quality linkage has solved-by-PR evidence via ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}.`
      : status === "invalid"
        ? `Cached issue-quality linkage marks linked issue(s) ${invalid.map((entry) => `#${entry.number}`).join(", ")} as not multiplier-eligible.`
        : status === "plausible"
          ? "Cached issue-quality linkage is plausible, but solved-by-PR evidence is not available yet."
          : status === "raw"
            ? "Cached issue-quality linkage has only raw issue references."
            : "Cached issue-quality linkage is unavailable for the linked issue(s).";
  return {
    status,
    source: "github_cache",
    issueNumbers,
    solvedByPullRequests,
    reason,
    warnings: [
      ...entries.flatMap((entry) => entry.linkage?.warnings ?? []),
      ...(missingIssues.length > 0 ? [`Issue-quality report did not include linked issue(s): ${missingIssues.map((number) => `#${number}`).join(", ")}.`] : []),
    ],
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
    // CR with classifyOpenPullRequest (pending-pr-scenarios.ts): an actionable
    // block (changes requested / bad mergeable state) takes precedence over age,
    // so a changes-requested PR is never optimistically modeled as "stale, likely
    // to close and free up an open-PR slot". Blocked must be checked before stale.
    if (isBlockedOpenPr(pr)) {
      blocked += 1;
      continue;
    }
    if (isStaleOpenPr(pr, args.nowMs)) {
      stale += 1;
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

function buildGitHubBranchStatus(input: LocalBranchAnalysisInput, pullRequests: PullRequestRecord[], checkSummaries: CheckSummaryRecord[]): GitHubBranchStatus {
  const match = findCurrentBranchPullRequest(input, pullRequests);
  if (!match) return { source: "cached_github_data", status: "no_pr", notes: ["No open GitHub PR was matched to the current branch metadata."] };
  const reviewDecision = (match.reviewDecision ?? "").toLowerCase();
  const mergeableState = (match.mergeableState ?? "").toLowerCase();
  const matchedChecks = matchingCheckSummaries(match, checkSummaries);
  const status =
    reviewDecision === "changes_requested"
      ? "needs_author"
      : mergeableState === "behind"
        ? "needs_author"
      : match.isDraft
        ? "pending_review"
        : ["dirty", "blocked", "conflicting", "unstable"].includes(mergeableState) || hasFailingCheck(matchedChecks)
          ? "failing_checks"
          : hasPendingCheck(matchedChecks)
            ? "pending_review"
          : mergeableState === "unknown"
            ? "unknown"
            : reviewDecision === "approved" || isApprovedOrMergeableOpenPr(match)
              ? "approved"
              : "pending_review";
  return {
    source: "cached_github_data",
    status,
    pullNumber: match.number,
    title: match.title,
    reviewDecision: match.reviewDecision,
    mergeableState: match.mergeableState,
    notes: githubBranchStatusNotes(status, match),
  };
}

export function findCurrentBranchPullRequest(input: LocalBranchAnalysisInput, pullRequests: PullRequestRecord[]): PullRequestRecord | undefined {
  const branchKeys = new Set([input.headRef, input.branchName].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
  const inputBaseRef = normalizeRefForMatch(input.baseRef);
  return pullRequests.find(
    (pr) =>
      pr.state === "open" &&
      sameLogin(pr.authorLogin, input.login) &&
      sameBaseRef(inputBaseRef, pr.baseRef) &&
      (Boolean(input.headSha && pr.headSha === input.headSha) || Boolean(pr.headRef && branchKeys.has(pr.headRef.toLowerCase()))),
  );
}

function githubBranchStatusNotes(status: GitHubBranchStatus["status"], pr: PullRequestRecord): string[] {
  if (status === "approved") return [`PR #${pr.number} is approved or mergeable in cached GitHub metadata.`];
  if (status === "needs_author" && (pr.mergeableState ?? "").toLowerCase() === "behind") return [`PR #${pr.number} is behind its base branch in cached GitHub metadata.`];
  if (status === "needs_author") return [`PR #${pr.number} has requested changes in cached GitHub metadata.`];
  if (status === "failing_checks") return [`PR #${pr.number} has failing, blocked, or conflicting GitHub status metadata.`];
  if (status === "pending_review" && pr.isDraft) return [`PR #${pr.number} is still a draft in cached GitHub metadata.`];
  if (status === "unknown") return [`PR #${pr.number} has incomplete GitHub status metadata; refresh checks before relying on it.`];
  return [`PR #${pr.number} is open but not yet approved or clearly blocked in cached GitHub metadata.`];
}

function normalizeRefForMatch(ref: string | null | undefined): string | undefined {
  const value = ref?.trim().toLowerCase();
  if (!value) return undefined;
  return value.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "").replace(/^(origin|upstream)\//, "");
}

function sameBaseRef(inputBaseRef: string | undefined, prBaseRef: string | null | undefined): boolean {
  if (!inputBaseRef) return true;
  return normalizeRefForMatch(prBaseRef) === inputBaseRef;
}

function matchingCheckSummaries(pr: PullRequestRecord, checkSummaries: CheckSummaryRecord[]): CheckSummaryRecord[] {
  return checkSummaries.filter(
    (check) =>
      (check.pullNumber !== undefined && check.pullNumber !== null && check.pullNumber === pr.number) ||
      (check.pullNumber === undefined || check.pullNumber === null ? Boolean(pr.headSha && check.headSha === pr.headSha) : false),
  );
}

function hasFailingCheck(checks: CheckSummaryRecord[]): boolean {
  return checks.some((check) => ["failure", "failed", "timed_out", "cancelled", "action_required", "startup_failure"].includes((check.conclusion ?? check.status).toLowerCase()));
}

function hasPendingCheck(checks: CheckSummaryRecord[]): boolean {
  return checks.some((check) => {
    const status = check.status.toLowerCase();
    const conclusion = check.conclusion?.toLowerCase();
    return !conclusion && !["completed", "success"].includes(status);
  });
}

function isMaintainerAuthoredPr(pr: PullRequestRecord, repo: RepositoryRecord | undefined, login: string): boolean {
  /* v8 ignore next -- Missing association is a defensive GitHub row fallback; observed association behavior is covered above. */
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
  githubBranchStatus: GitHubBranchStatus,
  branchEligibility: BranchEligibilityResult,
): LocalBranchAnalysis["localFindings"] {
  const failedValidation = (input.validation ?? []).filter((entry) => entry.status === "failed");
  const localScorerWarnings = sanitizeLocalScorerWarnings(input.localScorer?.warnings);
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
    ...(changedFiles.some((file) => file.status === "deleted")
      ? [
          {
            code: "deleted_paths_present",
            severity: "warning" as const,
            title: "Deleted paths detected",
            detail: "Deleted files are included in local metadata only; confirm the removal is intentional before submitting the change.",
          },
        ]
      : []),
    ...(changedFiles.some((file) => file.status === "renamed" || file.previousPath)
      ? [
          {
            code: "renamed_paths_present",
            severity: "info" as const,
            title: "Renamed paths detected",
            detail: "Renamed files are summarized from git metadata; reviewers should confirm history and import paths.",
          },
        ]
      : []),
    ...((input.validation ?? []).some((entry) => entry.status === "passed") && !changedFiles.some((file) => isTestFile(file.path))
      ? [
          {
            code: "validation_as_test_evidence",
            severity: "info" as const,
            title: "Validation commands supplied as test evidence",
            detail: "Passed local validation commands are treated as test evidence even when no test files changed.",
          },
        ]
      : []),
    ...(localScorerWarnings.length
      ? [
          {
            code: "local_scorer_warning",
            severity: "info" as const,
            title: "Local scorer diagnostics",
            detail: localScorerWarnings.join(" "),
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
    ...githubBranchFindings(githubBranchStatus),
    ...branchEligibilityFindings(branchEligibility),
    ...scorePreview.warnings
      .filter((warning) => !/branch eligibility/i.test(warning))
      .map((warning) => ({
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

function branchEligibilityFindings(branchEligibility: BranchEligibilityResult): LocalBranchAnalysis["localFindings"] {
  if (!branchEligibility.required) return [];
  const detail = branchEligibility.warnings.join(" ") || "Branch eligibility metadata did not confirm the linked issue assumption.";
  if (branchEligibility.status === "ineligible") {
    return [
      {
        code: "branch_eligibility_ineligible",
        severity: "warning" as const,
        title: "Branch eligibility blocks linked-issue assumptions",
        detail,
        action: "Clean up linked issue context or use a branch whose linked issue context is valid before submission.",
      },
    ];
  }
  if (branchEligibility.stale) {
    return [
      {
        code: "branch_eligibility_stale",
        severity: "warning" as const,
        title: "Branch eligibility metadata is stale",
        detail,
        action: "Refresh branch/base metadata and rerun branch analysis before submission.",
      },
    ];
  }
  if (branchEligibility.status === "unknown") {
    return [
      {
        code: branchEligibility.evidence === "missing" ? "branch_eligibility_missing" : "branch_eligibility_unknown",
        severity: "info" as const,
        title: branchEligibility.evidence === "missing" ? "Branch eligibility evidence missing" : "Branch eligibility unknown",
        detail,
        action: "Refresh branch/base metadata before relying on linked issue context.",
      },
    ];
  }
  return [];
}

function githubBranchFindings(status: GitHubBranchStatus): LocalBranchAnalysis["localFindings"] {
  if (status.status === "failing_checks" || status.status === "needs_author") {
    return [
      {
        code: "github_status_needs_work",
        severity: "warning" as const,
        title: status.status === "needs_author" ? "GitHub review needs author" : "GitHub checks need attention",
        detail: status.notes.join(" "),
        action: "Resolve GitHub review/check blockers before asking for maintainer review.",
      },
    ];
  }
  if (status.status === "unknown") {
    return [
      {
        code: "github_status_unknown",
        severity: "info" as const,
        title: "GitHub status is incomplete",
        detail: status.notes.join(" "),
        action: "Refresh GitHub checks and reviews before final submission.",
      },
    ];
  }
  return [];
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
  branchEligibility: BranchEligibilityResult,
): string {
  if (baseFreshness.status === "stale" || baseFreshness.status === "possibly_stale") return "Run `git fetch origin` and rerun; current diff size may be inflated by stale base state.";
  if (branchEligibility.required && branchEligibility.status === "ineligible") return "Rerun after branch/base metadata confirms eligibility or after linked issue assumptions change.";
  if (branchEligibility.required && (branchEligibility.stale || (branchEligibility.status === "unknown" && branchEligibility.evidence === "provided"))) {
    return "Refresh branch/base eligibility metadata and rerun before relying on linked issue assumptions.";
  }
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
    /* v8 ignore next -- The wait action is only prepended when ranked actions exist; fallback protects sparse score previews. */
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
  githubBranchStatus: GitHubBranchStatus;
  branchEligibility: BranchEligibilityResult;
  recommendedRerunCondition: string;
  manifestGuidance: FocusManifestGuidance;
}): LocalBranchAnalysis["prPacket"] {
  const topPaths = args.changedFiles.slice(0, 8).map(changedFileSummary);
  const publicSafeWarnings = [
    ...(args.roleContext.maintainerLane ? ["This is maintainer-lane context; present it as repo stewardship work."] : []),
    ...args.preflight.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => {
        /* v8 ignore next -- Local preflight findings currently use action/title; publicText is kept for the shared finding contract. */
        return finding.publicText ?? finding.action ?? finding.title;
      }),
    ...args.localFindings
      .filter((finding) => finding.code !== "score_preview_warning" && finding.severity === "warning")
      .flatMap((finding) => {
        /* v8 ignore next -- Warning local findings currently carry actions; title fallback protects future adapters. */
        return finding.action ? [finding.action] : [finding.title];
      }),
  ].filter(isPublicSafeText);
  const nextSteps = [
    ...publicSafeWarnings,
    ...args.manifestGuidance.publicNextSteps,
    args.baseFreshness.recommendation,
    publicSafeRerunCondition(args.recommendedRerunCondition),
    "Keep source upload disabled; this packet is based on local git metadata only.",
  ].filter((line): line is string => Boolean(line && isPublicSafeText(line)));
  const manifestFocus = manifestFocusLines(args.manifestGuidance);
  const validationLines =
    args.validationSummary.commands.length > 0
      ? args.validationSummary.commands.map((entry) => `- ${entry.status}: ${entry.command}${entry.durationMs !== undefined ? ` [${entry.durationMs}ms]` : ""}${entry.summary ? ` (${entry.summary})` : ""}`)
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
      { heading: "Linked Issue Hygiene", lines: linkedIssueHygieneLines(args.branchEligibility) },
      { heading: "Branch Freshness", lines: branchFreshnessLines(args.baseFreshness) },
      { heading: "GitHub Status", lines: githubStatusLines(args.githubBranchStatus) },
      ...(manifestFocus.length > 0 ? [{ heading: "Maintainer Focus", lines: manifestFocus }] : []),
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

function linkedIssueHygieneLines(branchEligibility: BranchEligibilityResult): string[] {
  if (!branchEligibility.required) return ["- No issue-specific branch gate was required from supplied metadata."];
  if (branchEligibility.status === "eligible" && branchEligibility.source !== "user_supplied") {
    return [
      "- Linked issue context was checked from local/GitHub metadata.",
      ...(branchEligibility.stale ? ["- Reconfirm linked issue and base branch metadata before submission."] : []),
    ];
  }
  if (branchEligibility.status === "eligible") {
    return ["- Linked issue context was not confirmed; verify the issue reference and base branch before submission."];
  }
  if (branchEligibility.status === "ineligible") {
    return ["- Linked issue context needs cleanup before presenting this PR as solving the issue."];
  }
  return ["- Linked issue context was not confirmed; verify the issue reference and base branch before submission."];
}

function publicSafeRerunCondition(condition: string): string {
  if (/account\/queue maturity|pending PRs merge\/close|open PR count|projected score|threshold|eligibility|multiplier|scoreability|score/i.test(condition)) {
    return "Rerun after any branch, base, or PR state changes before opening/submitting.";
  }
  return condition;
}

function branchFreshnessLines(freshness: LocalBranchAnalysis["baseFreshness"]): string[] {
  return [`- Base freshness: ${freshness.status}.`, ...freshness.warnings.filter(isPublicSafeText).map((warning) => `- ${warning}`), freshness.passedValidationCount > 0 ? `- Validation evidence supplied: ${freshness.passedValidationCount} passed command(s).` : "- No passed validation evidence was supplied."];
}

function githubStatusLines(status: GitHubBranchStatus): string[] {
  if (status.status === "no_pr") return ["- No open GitHub PR was matched to this branch."];
  return [`- PR #${status.pullNumber}: ${status.status.replace(/_/g, " ")}.`, ...status.notes.map((note) => `- ${note}`)].filter(isPublicSafeText);
}

function manifestFocusLines(guidance: FocusManifestGuidance): string[] {
  if (!guidance.present) return [];
  const lines = guidance.publicNextSteps.map((step) => `- ${step}`).filter(isPublicSafeText);
  return [...new Set(lines)].slice(0, 6);
}

function overlapCautionLines(collisions: LocalDiffPreflightResult["collisions"]): string[] {
  if (collisions.length === 0) return ["- No active overlap or WIP was detected from cached issue/PR metadata."];
  return collisions
    .slice(0, 3)
    .map((cluster) => `- Possible overlap or WIP (${cluster.risk}): ${cluster.reason} Check ${cluster.items.slice(0, 3).map((item) => `${collisionItemLabel(item.type)} #${item.number}`).join(", ")} before posting.`)
    .filter(isPublicSafeText);
}

function collisionItemLabel(type: LocalDiffPreflightResult["collisions"][number]["items"][number]["type"]): string {
  if (type === "pull_request") return "PR";
  /* v8 ignore next -- Engine collision tests cover issue items; local packet tests focus on PR overlap rendering. */
  if (type === "issue") return "issue";
  /* v8 ignore next -- Local diff preflight does not currently include merged PR collision items. */
  return "merged PR";
}

function changedFileSummary(file: LocalBranchChangedFile): string {
  return `${file.previousPath ? `${safeRepoPath(file.previousPath)} -> ${safeRepoPath(file.path)}` : safeRepoPath(file.path)} (${file.status ?? "modified"}, ${file.binary ? "binary" : `+${nonNegative(file.additions)}/-${nonNegative(file.deletions)}`})`;
}

function renderPrPacketMarkdown(title: string, sections: Array<{ heading: string; lines: string[] }>): string {
  return `${[`# ${title}`, ...sections.flatMap((section) => ["", `## ${section.heading}`, ...section.lines])].filter(isPublicSafeText).join("\n").trim()}\n`;
}

function summarizeValidation(validation: LocalBranchValidation[]): LocalBranchAnalysis["prPacket"]["validationSummary"] {
  return {
    passed: validation.filter((entry) => entry.status === "passed" || entry.status === "focused").length,
    failed: validation.filter((entry) => entry.status === "failed").length,
    notRun: validation.filter((entry) => entry.status === "not_run" || entry.status === "skipped" || entry.status === "unknown").length,
    commands: validation,
  };
}

function validationEvidence(validation: LocalBranchValidation[] | undefined): string[] {
  return (validation ?? [])
    .filter((entry) => entry.status === "passed" || entry.status === "focused")
    .map((entry) => entry.command);
}

function titleFromBranch(branchName: string | undefined): string | undefined {
  const cleaned = branchName?.replace(/^[-/_.\w]+\/(?=[^/]+$)/, "").replace(/[-_]+/g, " ").trim();
  return cleaned || undefined;
}

function firstCommitTitle(messages: string[] | undefined): string | undefined {
  return messages?.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim() || undefined;
}

function safeRepoPath(path: string): string {
  /* v8 ignore next -- Empty path fallback protects malformed local-git adapters; path redaction is covered by local branch tests. */
  return /^(\/Users\/|\/home\/|\/tmp\/|[A-Z]:\/Users\/)/i.test(String(path).replace(/\\/g, "/")) ? "[local path hidden]" : String(path || "(unknown path)").replace(/\\/g, "/");
}

export function isTestFile(file: string): boolean {
  // Keep local scoring aligned with slop/test-evidence matchers (#561 / #1046).
  return isTestPath(file);
}

export function isCodeFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniquePositiveInts(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function nonNegative(value: number | undefined): number {
  /* v8 ignore next -- NaN/undefined local-git stats normalize to zero and are covered through aggregate diff behavior. */
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function unique<T>(value: T, index: number, values: T[]): boolean {
  return values.indexOf(value) === index;
}
