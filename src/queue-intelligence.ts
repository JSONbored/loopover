export type ChecksStatus = "passing" | "failing" | "pending";
export type AuthorRole = "first-time" | "contributor" | "maintainer";
export type Recommendation = "review_now" | "needs_author" | "watch" | "redirect" | "maintainer_lane";

export interface LinkedIssue {
  qualityScore: number;
}

export interface PullRequestInput {
  number: number;
  author: string;
  authorRole: AuthorRole;
  isConfirmedMiner: boolean;
  linkedIssue: LinkedIssue | null;
  checksStatus: ChecksStatus;
  isStale: boolean;
  additions: number;
  deletions: number;
  title: string;
  body: string;
  duplicateCandidates: number[];
  createdAt: string;
  lastUpdatedAt: string;
}

export interface RepoContext {
  totalOpenPRs: number;
  avgReviewTimeDays: number;
  maintainerWorkload: number;
}

export interface AnalyzePRQueueResult {
  rankedPRs: PullRequestInput[];
  recommendations: Map<number, Recommendation>;
}

const LARGE_PR_CHANGE_THRESHOLD = 1500;
const LOW_ISSUE_QUALITY_THRESHOLD = 0.3;
const HIGH_ISSUE_QUALITY_THRESHOLD = 0.7;
const PENDING_STALE_THRESHOLD_DAYS = 2;
const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

export const FORBIDDEN_PUBLIC_COMMENT_WORDS = [
  "wallet",
  "hotkey",
  "raw trust score",
  "trust score",
  "coldkey",
  "seed phrase",
  "mnemonic",
  "payout",
  "reward estimate",
  "estimated rewards",
  "estimated reward",
  "rewards",
  "reward",
  "farming",
  "private reviewability",
  "reviewability internals",
  "reviewability",
  "private scoreability",
  "scoreability",
  "score preview",
  "estimated score",
  "public score estimate",
  "score estimate",
  "private rankings",
  "private ranking",
  "rankings",
  "ranking",
] as const;

function computeDaysSince(isoDateString: string, now: Date): number {
  // A malformed/empty timestamp -> NaN, which flows into computePrivateBurdenReductionScore and then the
  // analyzePRQueue sort comparator (`b.score - a.score`). NaN makes Array.sort non-deterministic, and even
  // Infinity would reintroduce that (`Infinity - Infinity = NaN` when two PRs share a bad timestamp), so the
  // fallback must be finite. 0 degrades a bad timestamp to "just-created" (lowest burden priority); mirrors the
  // issueAgeDays guard in signals/reward-risk.ts.
  const parsed = Date.parse(isoDateString);
  return Number.isFinite(parsed) ? (now.getTime() - parsed) / MILLISECONDS_PER_DAY : 0;
}

function isPRVeryLarge(pr: PullRequestInput): boolean {
  return pr.additions + pr.deletions > LARGE_PR_CHANGE_THRESHOLD;
}

function checkNeedsAuthorConditions(pr: PullRequestInput): boolean {
  if (pr.checksStatus === "failing") return true;
  if (pr.linkedIssue === null || pr.linkedIssue.qualityScore < LOW_ISSUE_QUALITY_THRESHOLD) return true;
  if (pr.title.trim() === "") return true;
  if (pr.body.trim() === "") return true;
  return false;
}

function computePrivateRecommendation(pr: PullRequestInput, now: Date): Recommendation {
  if (pr.authorRole === "maintainer") return "maintainer_lane";
  if (checkNeedsAuthorConditions(pr)) return "needs_author";
  if (pr.duplicateCandidates.length > 0) return "redirect";
  const isPendingTooLong =
    pr.checksStatus === "pending" && computeDaysSince(pr.lastUpdatedAt, now) > PENDING_STALE_THRESHOLD_DAYS;
  if (pr.isStale || isPRVeryLarge(pr) || isPendingTooLong) return "watch";
  return "review_now";
}

function computePrivateReviewabilityScore(pr: PullRequestInput): number {
  let privateReviewabilityScore = 0;
  if (pr.isConfirmedMiner) privateReviewabilityScore += 50;
  if (pr.checksStatus === "passing") privateReviewabilityScore += 20;
  if (pr.linkedIssue !== null && pr.linkedIssue.qualityScore > HIGH_ISSUE_QUALITY_THRESHOLD) {
    privateReviewabilityScore += 20;
  }
  if (checkNeedsAuthorConditions(pr)) privateReviewabilityScore -= 30;
  if (pr.isStale || isPRVeryLarge(pr)) privateReviewabilityScore -= 20;
  return privateReviewabilityScore;
}

function computePrivateBurdenReductionScore(pr: PullRequestInput, now: Date): number {
  const daysSinceCreated = computeDaysSince(pr.createdAt, now);
  return daysSinceCreated * 2 + (pr.additions + pr.deletions) / 100;
}

export async function analyzePRQueue(
  pullRequests: PullRequestInput[],
  _repoContext: RepoContext,
): Promise<AnalyzePRQueueResult> {
  const now = new Date();
  const recommendations = new Map<number, Recommendation>();

  const scored = pullRequests.map((pr) => {
    const recommendation = computePrivateRecommendation(pr, now);
    recommendations.set(pr.number, recommendation);
    const privateReviewabilityScore = computePrivateReviewabilityScore(pr);
    const privateBurdenReductionScore = computePrivateBurdenReductionScore(pr, now);
    return { pr, privateReviewabilityScore, privateBurdenReductionScore };
  });

  scored.sort((a, b) => {
    if (b.privateReviewabilityScore !== a.privateReviewabilityScore) {
      return b.privateReviewabilityScore - a.privateReviewabilityScore;
    }
    return b.privateBurdenReductionScore - a.privateBurdenReductionScore;
  });

  return { rankedPRs: scored.map(({ pr }) => pr), recommendations };
}

export function sanitizePublicComment(comment: string): string {
  for (const forbiddenWord of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
    if (comment.toLowerCase().includes(forbiddenWord.toLowerCase())) {
      throw new Error(`Public comment contains forbidden word: "${forbiddenWord}"`);
    }
  }
  return comment;
}

export function generatePublicComment(
  pr: PullRequestInput,
  _recommendation: Recommendation,
  isConfirmedMiner: boolean,
): string | null {
  if (!isConfirmedMiner) return null;

  const comment =
    pr.checksStatus === "passing"
      ? "Checks are passing. Ready for review."
      : "Please address the failing checks.";

  return sanitizePublicComment(comment);
}
