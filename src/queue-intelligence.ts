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
  "raw trust",
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
  "cohort",
  "miner-originated",
  "miner originated",
  "human-originated",
  "human originated",
] as const;

// A bare "score" is checked separately from the substring list above (not folded in as another entry):
// FORBIDDEN_PUBLIC_COMMENT_WORDS is matched with a plain case-insensitive `.includes()`, and an unqualified
// "score" substring also matches ordinary English words that carry no gittensor meaning at all ("underscore",
// "outscore", "overscore"), which would cause safe comments to be dropped for no reason. It still must be
// caught -- the canonical public/private boundary (PUBLIC_UNSAFE_TERMS in src/signals/redaction.ts) treats any
// bare score/cohort mention as unsafe -- so it's matched here with the same `\bscore\w*\b` word-boundary shape
// the canonical pattern uses (catches "score"/"scores"/"scored"/"scorer", though not "scoring", which drops
// the trailing "e" and so isn't a literal "score" substring -- the canonical pattern shares this same limit)
// instead of a plain substring test.
const BARE_SCORE_TERM_PATTERN = /\bscore\w*\b/i;

function computeDaysSince(isoDateString: string, now: Date): number {
  // A malformed/empty timestamp -> NaN, which flows into computePrivateBurdenReductionScore and then the
  // analyzePRQueue sort comparator (`b.score - a.score`). NaN makes Array.sort non-deterministic, and even
  // Infinity would reintroduce that (`Infinity - Infinity = NaN` when two PRs share a bad timestamp), so the
  // fallback must be finite. 0 degrades a bad timestamp to "just-created" (lowest burden priority) for queue
  // sorting — independent of reward-risk freshness, which floors unknown issue ages to minimum freshness.
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

/** CSV/whitespace repo allowlist for {@link isPublicScoreTermSafeForRepo} -- same fail-closed/wildcard parse
 *  shape as auth/security.ts's MCP repo allowlists (a distinct, smaller local copy rather than a shared
 *  import: this one governs a content-safety exemption, not an actuation/read trust boundary, and the two
 *  concerns should stay independently editable). Unset/empty ⇒ deny (fail closed: the bare-score check stays
 *  ENFORCED for every repo unless an operator explicitly opts one in). `*`/`all` is deliberately NOT treated
 *  as a wildcard here, unlike the MCP allowlists -- this exemption is safety-relevant enough that a blanket
 *  opt-in-everything value would silently cover a FUTURE repo that DOES have private trust/reward data (e.g.
 *  loopover itself), which the MCP read/actuation allowlists' analogous risk doesn't share.
 *  LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS is the env var; config-as-code, never hardcoded per #config-as-code. */
export function isPublicScoreTermSafeForRepo(env: { LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS?: string }, repoFullName: string): boolean {
  const entries = (env.LOOPOVER_PUBLIC_SCORE_TERMS_ALLOWED_REPOS ?? "")
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.includes(repoFullName.toLowerCase());
}

/** `allowBareScoreTerm` (#public-score-terms-scoping, default false = today's unchanged behavior): the bare
 *  "\bscore\w*\b" check exists to catch a LEAKED gittensor trust/reward VALUE, but it also matches the word
 *  "score" used as ordinary, already-public API vocabulary -- a real problem for a repo like metagraphed,
 *  whose own public schema legitimately has fields named `totalScore`/`credibility`/`baseTotalScore`. Any AI
 *  review discussing that code naturally uses the word "score" and, before this option existed, had its
 *  WHOLE narrative assessment silently discarded (observed live: metagraphed#8038 and recurring). The other,
 *  EXPLICIT-PHRASE entries in FORBIDDEN_PUBLIC_COMMENT_WORDS ("trust score", "reward", "scoreability", ...)
 *  are NEVER skippable by this flag -- those name the actual private concept regardless of repo, so they stay
 *  enforced everywhere; only the over-broad bare-word check is ever relaxed, and only where a caller has
 *  positively confirmed (via a repo allowlist, never a blanket default) that "score" is safe public
 *  vocabulary for that repo. */
export function sanitizePublicComment(comment: string, options?: { allowBareScoreTerm?: boolean }): string {
  for (const forbiddenWord of FORBIDDEN_PUBLIC_COMMENT_WORDS) {
    if (comment.toLowerCase().includes(forbiddenWord.toLowerCase())) {
      throw new Error(`Public comment contains forbidden word: "${forbiddenWord}"`);
    }
  }
  if (!options?.allowBareScoreTerm) {
    const bareScoreMatch = comment.match(BARE_SCORE_TERM_PATTERN);
    if (bareScoreMatch) {
      throw new Error(`Public comment contains forbidden word: "${bareScoreMatch[0]}"`);
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
