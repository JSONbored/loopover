import {
  listAgentActions,
  listAgentRunsForActor,
  listContributorIssues,
  listContributorPullRequests,
  upsertAgentRecommendationOutcome,
} from "../db/repositories";
import type {
  AgentActionRecord,
  AgentRecommendationOutcomeRecord,
  AgentRecommendationOutcomeState,
  AgentRecommendationOutcomeTargetType,
  AgentRunRecord,
  IssueRecord,
  PullRequestRecord,
} from "../types";
import { nowIso } from "../utils/json";

export const DEFAULT_RECOMMENDATION_OUTCOME_STALE_DAYS = 14;
export const DEFAULT_RECOMMENDATION_OUTCOME_IGNORED_DAYS = 7;

export type RecommendationOutcomeEvaluationResult = {
  login: string;
  evaluatedAt: string;
  outcomes: AgentRecommendationOutcomeRecord[];
  skippedFreshActions: number;
};

export async function evaluateRecommendationOutcomes(
  env: Env,
  login: string,
  options: { now?: string; runLimit?: number; staleAfterDays?: number; ignoredAfterDays?: number } = {},
): Promise<RecommendationOutcomeEvaluationResult> {
  const evaluatedAt = options.now ?? nowIso();
  const staleAfterMs = daysToMs(options.staleAfterDays ?? DEFAULT_RECOMMENDATION_OUTCOME_STALE_DAYS);
  const ignoredAfterMs = daysToMs(options.ignoredAfterDays ?? DEFAULT_RECOMMENDATION_OUTCOME_IGNORED_DAYS);
  const [runs, pullRequests, issues] = await Promise.all([
    listAgentRunsForActor(env, login, options.runLimit ?? 50),
    listContributorPullRequests(env, login),
    listContributorIssues(env, login),
  ]);
  const completedRuns = runs.filter((run) => run.status === "completed");
  const actionGroups = await Promise.all(completedRuns.map(async (run) => ({ run, actions: await listAgentActions(env, run.id) })));
  const classifications = actionGroups.flatMap(({ run, actions }) =>
    actions.map((action) => classifyRecommendationOutcome({ run, action, pullRequests, issues, evaluatedAt, staleAfterMs, ignoredAfterMs })),
  );
  const classified = classifications.filter((outcome): outcome is AgentRecommendationOutcomeRecord => outcome !== null);
  const outcomes = [];
  for (const outcome of classified) outcomes.push(await upsertAgentRecommendationOutcome(env, outcome));
  return {
    login,
    evaluatedAt,
    outcomes,
    skippedFreshActions: classifications.length - classified.length,
  };
}

export function classifyRecommendationOutcome(args: {
  run: AgentRunRecord;
  action: AgentActionRecord;
  pullRequests: PullRequestRecord[];
  issues: IssueRecord[];
  evaluatedAt: string;
  staleAfterMs: number;
  ignoredAfterMs: number;
}): AgentRecommendationOutcomeRecord | null {
  const actionAt = timestamp(args.action.createdAt ?? args.run.updatedAt ?? args.run.createdAt);
  const evaluatedAt = timestamp(args.evaluatedAt);
  if (!Number.isFinite(actionAt) || !Number.isFinite(evaluatedAt)) return null;
  const actionAgeMs = evaluatedAt - actionAt;
  const targetRepoFullName = args.action.targetRepoFullName ?? repoFromPayload(args.action);
  const exactPr = targetRepoFullName && args.action.targetPullNumber
    ? args.pullRequests.find((pr) => sameRepo(pr.repoFullName, targetRepoFullName) && pr.number === args.action.targetPullNumber)
    : undefined;
  if (exactPr) {
    return outcomeFromPullRequest({
      run: args.run,
      action: args.action,
      pr: exactPr,
      matchedBy: "target_pull_request",
      evaluatedAt: args.evaluatedAt,
      actionAt,
      actionAgeMs,
      staleAfterMs: args.staleAfterMs,
    });
  }

  const exactIssue = targetRepoFullName && args.action.targetIssueNumber
    ? args.issues.find((issue) => sameRepo(issue.repoFullName, targetRepoFullName) && issue.number === args.action.targetIssueNumber)
    : undefined;
  if (exactIssue) {
    return outcomeFromIssue({
      run: args.run,
      action: args.action,
      issue: exactIssue,
      matchedBy: "target_issue",
      evaluatedAt: args.evaluatedAt,
      actionAt,
      actionAgeMs,
      staleAfterMs: args.staleAfterMs,
    });
  }

  const laterPr = targetRepoFullName ? firstLaterPullRequest(args.pullRequests, args.run.actorLogin, targetRepoFullName, args.action.targetIssueNumber, actionAt) : undefined;
  if (laterPr) {
    return outcomeFromPullRequest({
      run: args.run,
      action: args.action,
      pr: laterPr,
      matchedBy: args.action.targetIssueNumber ? "linked_issue_pull_request" : "later_repo_pull_request",
      evaluatedAt: args.evaluatedAt,
      actionAt,
      actionAgeMs,
      staleAfterMs: args.staleAfterMs,
    });
  }

  const laterIssue = targetRepoFullName ? firstLaterIssue(args.issues, args.run.actorLogin, targetRepoFullName, actionAt) : undefined;
  if (laterIssue) {
    return outcomeFromIssue({
      run: args.run,
      action: args.action,
      issue: laterIssue,
      matchedBy: "later_repo_issue",
      evaluatedAt: args.evaluatedAt,
      actionAt,
      actionAgeMs,
      staleAfterMs: args.staleAfterMs,
    });
  }

  if (actionAgeMs < args.ignoredAfterMs) return null;
  return baseOutcome(args.run, args.action, {
    outcomeState: "ignored",
    outcomeTargetType: targetRepoFullName ? "repository" : "none",
    outcomeRepoFullName: targetRepoFullName ?? null,
    maintainerLane: targetRepoFullName ? isMaintainerLane(args.run.actorLogin, targetRepoFullName) : false,
    confidence: targetRepoFullName ? "medium" : "low",
    reason: targetRepoFullName
      ? "No later cached PR or issue activity matched this recommendation after the ignored-outcome window."
      : "Recommendation did not include a target repo, PR, or issue that can be deterministically matched.",
    detectedAt: args.evaluatedAt,
    metadata: { matchedBy: "no_cached_activity", actionAgeDays: Math.floor(actionAgeMs / daysToMs(1)) },
  });
}

function outcomeFromPullRequest(args: {
  run: AgentRunRecord;
  action: AgentActionRecord;
  pr: PullRequestRecord;
  matchedBy: string;
  evaluatedAt: string;
  actionAt: number;
  actionAgeMs: number;
  staleAfterMs: number;
}): AgentRecommendationOutcomeRecord {
  const state = pullRequestOutcomeState(args.pr, args.action, args.actionAt, args.actionAgeMs, args.staleAfterMs);
  const maintainerLane = isMaintainerLane(args.run.actorLogin, args.pr.repoFullName, args.pr.authorAssociation);
  return baseOutcome(args.run, args.action, {
    outcomeState: state,
    outcomeTargetType: "pull_request",
    outcomeRepoFullName: args.pr.repoFullName,
    outcomePullNumber: args.pr.number,
    maintainerLane,
    confidence: state === "ignored" ? "medium" : "high",
    reason: pullRequestOutcomeReason(state, args.pr),
    sourceUpdatedAt: args.pr.updatedAt ?? args.pr.createdAt,
    detectedAt: args.evaluatedAt,
    metadata: {
      matchedBy: args.matchedBy,
      pullRequestState: args.pr.state,
      reviewDecision: args.pr.reviewDecision ?? null,
      mergeableState: args.pr.mergeableState ?? null,
    },
  });
}

function outcomeFromIssue(args: {
  run: AgentRunRecord;
  action: AgentActionRecord;
  issue: IssueRecord;
  matchedBy: string;
  evaluatedAt: string;
  actionAt: number;
  actionAgeMs: number;
  staleAfterMs: number;
}): AgentRecommendationOutcomeRecord {
  const state = issueOutcomeState(args.issue, args.actionAt, args.actionAgeMs, args.staleAfterMs);
  const maintainerLane = isMaintainerLane(args.run.actorLogin, args.issue.repoFullName, args.issue.authorAssociation);
  return baseOutcome(args.run, args.action, {
    outcomeState: state,
    outcomeTargetType: "issue",
    outcomeRepoFullName: args.issue.repoFullName,
    outcomeIssueNumber: args.issue.number,
    maintainerLane,
    confidence: state === "ignored" ? "medium" : "high",
    reason: issueOutcomeReason(state, args.issue),
    sourceUpdatedAt: args.issue.updatedAt ?? args.issue.createdAt,
    detectedAt: args.evaluatedAt,
    metadata: {
      matchedBy: args.matchedBy,
      issueState: args.issue.state,
    },
  });
}

function baseOutcome(
  run: AgentRunRecord,
  action: AgentActionRecord,
  outcome: {
    outcomeState: AgentRecommendationOutcomeState;
    outcomeTargetType: AgentRecommendationOutcomeTargetType;
    outcomeRepoFullName?: string | null | undefined;
    outcomePullNumber?: number | null | undefined;
    outcomeIssueNumber?: number | null | undefined;
    maintainerLane: boolean;
    confidence: AgentRecommendationOutcomeRecord["confidence"];
    reason: string;
    sourceUpdatedAt?: string | null | undefined;
    detectedAt: string;
    metadata: AgentRecommendationOutcomeRecord["metadata"];
  },
): AgentRecommendationOutcomeRecord {
  return {
    actionId: action.id,
    runId: run.id,
    actorLogin: run.actorLogin,
    actionType: action.actionType,
    targetRepoFullName: action.targetRepoFullName,
    targetPullNumber: action.targetPullNumber,
    targetIssueNumber: action.targetIssueNumber,
    outcomeState: outcome.outcomeState,
    outcomeTargetType: outcome.outcomeTargetType,
    outcomeRepoFullName: outcome.outcomeRepoFullName,
    outcomePullNumber: outcome.outcomePullNumber,
    outcomeIssueNumber: outcome.outcomeIssueNumber,
    maintainerLane: outcome.maintainerLane,
    confidence: outcome.confidence,
    reason: outcome.reason,
    sourceUpdatedAt: outcome.sourceUpdatedAt,
    detectedAt: outcome.detectedAt,
    metadata: {
      actionStatus: action.status,
      actionType: action.actionType,
      safetyClass: action.safetyClass,
      ...outcome.metadata,
    },
  };
}

function pullRequestOutcomeState(
  pr: PullRequestRecord,
  action: AgentActionRecord,
  actionAt: number,
  actionAgeMs: number,
  staleAfterMs: number,
): AgentRecommendationOutcomeState {
  const updatedAt = timestamp(pr.updatedAt ?? pr.createdAt);
  const createdAt = timestamp(pr.createdAt ?? pr.updatedAt);
  const mergedAt = timestamp(pr.mergedAt);
  if ((Number.isFinite(mergedAt) && mergedAt >= actionAt) || (!pr.mergedAt && pr.state === "merged" && updatedAt >= actionAt)) return "merged";
  if (pr.state === "closed" && updatedAt >= actionAt) return "closed";
  const positiveOpenSignal = pr.reviewDecision === "APPROVED" || pr.mergeableState === "clean";
  if (action.targetPullNumber && positiveOpenSignal && updatedAt >= actionAt) return "improved";
  if (createdAt >= actionAt || updatedAt > actionAt) return "accepted";
  if (actionAgeMs >= staleAfterMs) return "stale";
  return "ignored";
}

function issueOutcomeState(issue: IssueRecord, actionAt: number, actionAgeMs: number, staleAfterMs: number): AgentRecommendationOutcomeState {
  const updatedAt = timestamp(issue.updatedAt ?? issue.createdAt);
  const createdAt = timestamp(issue.createdAt ?? issue.updatedAt);
  if (issue.state !== "open" && updatedAt >= actionAt) return "closed";
  if (createdAt >= actionAt || updatedAt > actionAt) return "accepted";
  if (actionAgeMs >= staleAfterMs) return "stale";
  return "ignored";
}

function pullRequestOutcomeReason(state: AgentRecommendationOutcomeState, pr: PullRequestRecord): string {
  if (state === "merged") return `${pr.repoFullName}#${pr.number} merged after the recommendation snapshot.`;
  if (state === "closed") return `${pr.repoFullName}#${pr.number} closed without a merge after the recommendation snapshot.`;
  if (state === "improved") return `${pr.repoFullName}#${pr.number} remains open but now has approval or clean mergeability evidence.`;
  if (state === "accepted") return `${pr.repoFullName}#${pr.number} shows later cached activity matching the recommendation.`;
  if (state === "stale") return `${pr.repoFullName}#${pr.number} remains open with no later activity past the stale-outcome window.`;
  return `${pr.repoFullName}#${pr.number} is visible but has no later positive or terminal outcome yet.`;
}

function issueOutcomeReason(state: AgentRecommendationOutcomeState, issue: IssueRecord): string {
  if (state === "closed") return `${issue.repoFullName}#${issue.number} closed after the recommendation snapshot.`;
  if (state === "accepted") return `${issue.repoFullName}#${issue.number} shows later cached issue activity matching the recommendation.`;
  if (state === "stale") return `${issue.repoFullName}#${issue.number} remains open with no later activity past the stale-outcome window.`;
  return `${issue.repoFullName}#${issue.number} is visible but has no later terminal outcome yet.`;
}

function firstLaterPullRequest(
  pullRequests: PullRequestRecord[],
  login: string,
  repoFullName: string,
  linkedIssueNumber: number | null | undefined,
  actionAt: number,
): PullRequestRecord | undefined {
  return pullRequests
    .filter((pr) => sameRepo(pr.repoFullName, repoFullName) && sameLogin(pr.authorLogin, login))
    .filter((pr) => !linkedIssueNumber || pr.linkedIssues.includes(linkedIssueNumber))
    .filter((pr) => timestamp(pr.createdAt ?? pr.updatedAt) >= actionAt)
    .sort((left, right) => timestamp(left.createdAt ?? left.updatedAt) - timestamp(right.createdAt ?? right.updatedAt) || left.number - right.number)[0];
}

function firstLaterIssue(issues: IssueRecord[], login: string, repoFullName: string, actionAt: number): IssueRecord | undefined {
  return issues
    .filter((issue) => sameRepo(issue.repoFullName, repoFullName) && sameLogin(issue.authorLogin, login))
    .filter((issue) => timestamp(issue.createdAt ?? issue.updatedAt) >= actionAt)
    .sort((left, right) => timestamp(left.createdAt ?? left.updatedAt) - timestamp(right.createdAt ?? right.updatedAt) || left.number - right.number)[0];
}

function repoFromPayload(action: AgentActionRecord): string | null {
  const payload = action.payload as Record<string, unknown>;
  const decision = payload.decision as { repoFullName?: unknown } | undefined;
  const nestedAction = payload.action as { repoFullName?: unknown } | undefined;
  if (typeof decision?.repoFullName === "string") return decision.repoFullName;
  if (typeof nestedAction?.repoFullName === "string") return nestedAction.repoFullName;
  return null;
}

function isMaintainerLane(login: string, repoFullName: string, association?: string | null | undefined): boolean {
  const owner = repoFullName.split("/")[0] ?? "";
  return sameLogin(owner, login) || association === "OWNER" || association === "MEMBER" || association === "COLLABORATOR";
}

function sameLogin(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function sameRepo(left: string | null | undefined, right: string | null | undefined): boolean {
  return sameLogin(left, right);
}

function timestamp(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function daysToMs(days: number): number {
  return Math.max(0, days) * 24 * 60 * 60 * 1000;
}
