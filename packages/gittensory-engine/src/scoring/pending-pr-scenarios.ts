import type { CheckSummaryRecord, PullRequestRecord, PullRequestReviewRecord, RoleContext } from "./types.js";
import type { ScorePreviewInput } from "./preview.js";

// Deterministic subset of the backend's `src/scoring/pending-pr-scenarios.ts` (#2282): the pure
// classification/detection logic that only needs already-fetched PR/review/check records. The two
// D1-fetching loaders (`loadContributorRepoOpenPrSignalRecords`, `loadContributorRepoOpenPrSignals`) stay in
// `src/scoring/pending-pr-scenarios.ts`, which imports the pure pieces below back from this package.

export type OpenPrPendingClass =
  | "merge_ready"
  | "stale_likely_close"
  | "draft"
  | "blocked"
  | "maintainer_lane"
  | "open_other";

export type ClassifiedOpenPullRequest = {
  repoFullName: string;
  number: number;
  title: string;
  classification: OpenPrPendingClass;
  reasons: string[];
};

export type PendingPrScenarioDetection = {
  source: "github_observed" | "user_supplied";
  pendingMergedPrCount: number;
  pendingClosedPrCount: number;
  approvedPrCount: number;
  expectedOpenPrCountAfterMerge?: number | undefined;
  scenarioNotes: string[];
  classified: ClassifiedOpenPullRequest[];
};

export type ContributorRepoOpenPrSignals = {
  reviewsByPullNumber: Map<number, PullRequestReviewRecord[]>;
  checksByPullNumber: Map<number, CheckSummaryRecord[]>;
};

const STALE_DAYS = 14;

// Real draft markers only — "[draft]", "Draft:", "Draft -"; the delimiter keeps "Drafting" and
// "draft-js" from matching. Trailing \s* lets the same pattern also strip the marker for dedup keys.
export const DRAFT_TITLE_PATTERN = /^(?:\[\s*draft\s*\]|draft(?:\s*:|\s+-))\s*/i;

// Mirrors `src/github/commands.ts`'s `isMaintainerAssociation`/`MAINTAINER_ASSOCIATIONS` exactly. Duplicated
// here (rather than imported) because this package cannot reach into `src/`; keep the two in sync by hand.
const MAINTAINER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function isMaintainerAssociation(association: string | null | undefined): boolean {
  return Boolean(association && MAINTAINER_ASSOCIATIONS.has(association));
}

export function detectPendingPrScenario(args: {
  login: string;
  repoFullName: string;
  pullRequests: PullRequestRecord[];
  roleContext: RoleContext;
  openPrCount?: number | undefined;
  reviewsByPullNumber?: Map<number, PullRequestReviewRecord[]> | undefined;
  checksByPullNumber?: Map<number, CheckSummaryRecord[]> | undefined;
  excludePullNumbers?: number[] | undefined;
  userSupplied?: Pick<
    ScorePreviewInput,
    "pendingMergedPrCount" | "pendingClosedPrCount" | "approvedPrCount" | "expectedOpenPrCountAfterMerge" | "projectedCredibility" | "scenarioNotes"
  > | undefined;
}): PendingPrScenarioDetection | null {
  const user = args.userSupplied;
  const hasUserCounts =
    user?.pendingMergedPrCount !== undefined ||
    user?.pendingClosedPrCount !== undefined ||
    user?.approvedPrCount !== undefined ||
    user?.expectedOpenPrCountAfterMerge !== undefined;
  if (hasUserCounts) {
    return {
      source: "user_supplied",
      pendingMergedPrCount: nonNegative(user?.pendingMergedPrCount),
      pendingClosedPrCount: nonNegative(user?.pendingClosedPrCount),
      approvedPrCount: nonNegative(user?.approvedPrCount),
      ...(user?.expectedOpenPrCountAfterMerge !== undefined ? { expectedOpenPrCountAfterMerge: nonNegative(user.expectedOpenPrCountAfterMerge) } : {}),
      scenarioNotes: user?.scenarioNotes ?? [],
      classified: [],
    };
  }

  const excluded = new Set(args.excludePullNumbers ?? []);
  const contributorOpen = args.pullRequests.filter(
    (pr) =>
      sameRepoFullName(pr.repoFullName, args.repoFullName) &&
      pr.state === "open" &&
      sameLogin(pr.authorLogin, args.login) &&
      !excluded.has(pr.number),
  );
  if (contributorOpen.length === 0) return null;

  const classified = contributorOpen.map((pr) =>
    classifyOpenPullRequest({
      pr,
      roleContext: args.roleContext,
      reviews: args.reviewsByPullNumber?.get(pr.number) ?? [],
      checks: args.checksByPullNumber?.get(pr.number) ?? [],
    }),
  );

  const mergeReady = classified.filter((entry) => entry.classification === "merge_ready");
  const staleLikelyClose = classified.filter((entry) => entry.classification === "stale_likely_close");
  const pendingMergedPrCount = mergeReady.length;
  const pendingClosedPrCount = staleLikelyClose.length;
  if (pendingMergedPrCount === 0 && pendingClosedPrCount === 0) return null;

  const currentOpen = args.openPrCount ?? contributorOpen.length;
  const expectedOpenPrCountAfterMerge = Math.max(0, currentOpen - pendingMergedPrCount - pendingClosedPrCount);
  const scenarioNotes = [
    "GitHub-observed open PR state from cached reviews, checks, and activity timestamps (estimate only).",
    ...(pendingMergedPrCount > 0
      ? [`${pendingMergedPrCount} open PR(s) look merge-ready (approved, no changes requested, no failing checks, not draft/stale).`]
      : []),
    ...(pendingClosedPrCount > 0 ? [`${pendingClosedPrCount} open PR(s) look stale and may be closed instead of merged.`] : []),
    ...classified
      .filter((entry) => entry.classification === "draft" || entry.classification === "blocked" || entry.classification === "maintainer_lane")
      .map((entry) => `PR #${entry.number} treated as ${entry.classification.replace(/_/g, " ")} for this projection.`),
  ];

  return {
    source: "github_observed",
    pendingMergedPrCount,
    pendingClosedPrCount,
    approvedPrCount: mergeReady.length,
    expectedOpenPrCountAfterMerge,
    scenarioNotes,
    classified,
  };
}

export function classifyOpenPullRequest(args: {
  pr: PullRequestRecord;
  roleContext: RoleContext;
  reviews: PullRequestReviewRecord[];
  checks: CheckSummaryRecord[];
  duplicateProne?: boolean | undefined;
  missingTests?: boolean | undefined;
}): ClassifiedOpenPullRequest {
  const reasons: string[] = [];
  if (args.roleContext.maintainerLane) {
    reasons.push("Maintainer-lane context for this repo; not counted as outside-contributor pending reward work.");
    return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "maintainer_lane", reasons };
  }
  if (isMaintainerAssociation(args.pr.authorAssociation)) {
    reasons.push("Author association indicates maintainer-authored work.");
    return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "maintainer_lane", reasons };
  }
  if (isDraftPullRequest(args.pr)) {
    reasons.push("Draft PRs are not treated as likely to land.");
    return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "draft", reasons };
  }

  const approvalCount = args.reviews.filter((review) => review.state.toUpperCase() === "APPROVED").length;
  const changeRequestCount = args.reviews.filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED").length;
  const checkFailureCount = args.checks.filter(
    (check) => check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "cancelled",
  ).length;
  const ageDays = daysSince(args.pr.updatedAt ?? args.pr.createdAt);

  if (args.duplicateProne) reasons.push("Overlapping open work detected in the same repo (possible duplicate or WIP collision).");
  if (args.missingTests) reasons.push("Cached file list shows code changes without matching test files.");
  if (changeRequestCount > 0) reasons.push(`${changeRequestCount} changes-requested review(s).`);
  if (checkFailureCount > 0) reasons.push(`${checkFailureCount} failing or cancelled check(s).`);
  if (approvalCount === 0) reasons.push("No approved review in cache.");

  if (changeRequestCount > 0 || checkFailureCount > 0 || approvalCount === 0) {
    return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "blocked", reasons };
  }

  if (ageDays >= STALE_DAYS) {
    reasons.push(`No meaningful update in at least ${STALE_DAYS} days; may be closed instead of merged.`);
    return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "stale_likely_close", reasons };
  }

  reasons.push("Approved with passing checks and recent activity; treated as likely to merge (estimate).");
  return { repoFullName: args.pr.repoFullName, number: args.pr.number, title: args.pr.title, classification: "merge_ready", reasons };
}

export function applyPendingPrDetectionToScoreInput(
  input: ScorePreviewInput,
  detection: PendingPrScenarioDetection | null,
): ScorePreviewInput {
  if (!detection || detection.source === "user_supplied") return input;
  return {
    ...input,
    pendingMergedPrCount: detection.pendingMergedPrCount,
    pendingClosedPrCount: detection.pendingClosedPrCount,
    approvedPrCount: detection.approvedPrCount,
    expectedOpenPrCountAfterMerge: detection.expectedOpenPrCountAfterMerge,
    scenarioNotes: [...(input.scenarioNotes ?? []), ...detection.scenarioNotes],
    pendingScenarioObserved: true,
  };
}

function isDraftPullRequest(pr: PullRequestRecord): boolean {
  if (pr.isDraft) return true;
  if (DRAFT_TITLE_PATTERN.test(pr.title.trim())) return true;
  return pr.labels.some((label) => label.toLowerCase() === "draft" || label.toLowerCase() === "wip");
}

function sameRepoFullName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return Boolean(value && value.toLowerCase() === login.toLowerCase());
}

function daysSince(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - parsed) / 86_400_000);
}

function nonNegative(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
