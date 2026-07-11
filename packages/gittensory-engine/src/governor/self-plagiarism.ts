// Self-plagiarism throttle (#2345): pure classifier over a prospective PR's diff fingerprint vs the miner's own
// recent submission history. Gates nothing on its own — the Governor open_pr chokepoint (#2340) composes this
// verdict with rate-limit, budget caps, and non-convergence before recording to the governor ledger.
//
// ELECTION: reuses {@link isDuplicateClusterWinnerByClaim}'s claim-time / earliest-wins ordering so a
// near-duplicate cluster has exactly one survivor — sparse or ambiguous timing fails closed (deny), mirroring
// duplicate-cluster adjudication in src/signals/duplicate-winner.ts.
//
// DETECTOR ONLY — no IO, no Date.now(), no randomness. Identical inputs always yield the identical verdict.

import {
  isDuplicateClusterWinnerByClaim,
  resolveDuplicateClusterWinnerNumber,
  type DuplicateClaimMember,
} from "../duplicate-winner.js";
import type { GovernorLedgerEventType } from "../governor-ledger.js";

/** Conservative default — only very similar diff fingerprints throttle (not hard-coded at call sites). */
export const DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD = 0.85;

export type SelfPlagiarismConfig = {
  /** Jaccard similarity in [0, 1] at/above which two fingerprints read as near-duplicates. */
  similarityThreshold: number;
};

export const DEFAULT_SELF_PLAGIARISM_CONFIG: Readonly<SelfPlagiarismConfig> = Object.freeze({
  similarityThreshold: DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
});

/** One prior submission from the miner's own history (same actor only — never cross-miner). */
export type OwnSubmissionRecord = {
  repoFullName: string;
  /** Stable diff fingerprint for similarity comparison (caller-normalized token set or hash). */
  fingerprint: string;
  /** When the submission was recorded — election ordering signal (ISO-8601). */
  submittedAt?: string | null | undefined;
  pullRequestNumber?: number | null | undefined;
  issueNumber?: number | null | undefined;
};

export type SelfPlagiarismCandidate = OwnSubmissionRecord;

export type SelfPlagiarismVerdict = {
  allowed: boolean;
  /** Aligns with governor-ledger vocabulary: `allowed`, `throttled`, or `denied`. */
  eventType: GovernorLedgerEventType;
  reason: string;
  /** Highest-similarity prior that triggered the throttle, when present. */
  matchedSubmission?: OwnSubmissionRecord;
  similarity?: number;
};

function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD;
  return Math.min(1, Math.max(0, value));
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function tokenSet(fingerprint: string): Set<string> {
  return new Set(
    fingerprint
      .split(/[\s:,]+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

/** Token-set Jaccard similarity — deterministic and dependency-free for diff fingerprint comparison. */
export function fingerprintSimilarity(left: string, right: string): number {
  const setLeft = tokenSet(normalizeFingerprint(left) ?? "");
  const setRight = tokenSet(normalizeFingerprint(right) ?? "");
  if (setLeft.size === 0 && setRight.size === 0) return 1;
  if (setLeft.size === 0 || setRight.size === 0) return 0;
  let intersection = 0;
  for (const token of setLeft) {
    if (setRight.has(token)) intersection += 1;
  }
  const union = setLeft.size + setRight.size - intersection;
  return intersection / union;
}

function submissionTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asClaimMember(record: OwnSubmissionRecord): DuplicateClaimMember {
  const number =
    (typeof record.pullRequestNumber === "number" && Number.isFinite(record.pullRequestNumber)
      ? record.pullRequestNumber
      : null) ??
    (typeof record.issueNumber === "number" && Number.isFinite(record.issueNumber) ? record.issueNumber : null) ??
    0;
  return { number, linkedIssueClaimedAt: record.submittedAt };
}

function buildVerdict(
  allowed: boolean,
  eventType: GovernorLedgerEventType,
  reason: string,
  matchedSubmission?: OwnSubmissionRecord,
  similarity?: number,
): SelfPlagiarismVerdict {
  return {
    allowed,
    eventType,
    reason,
    ...(matchedSubmission ? { matchedSubmission } : {}),
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

/**
 * Compare a prospective PR fingerprint against the miner's own recent submissions. Fail closed when the
 * candidate fingerprint or election timing is missing/ambiguous. When near-duplicates exist, only the
 * earliest claimant wins — later submissions are throttled.
 */
export function selfPlagiarismCheck(
  candidateFingerprint: SelfPlagiarismCandidate,
  recentOwnSubmissions: readonly OwnSubmissionRecord[],
  config: SelfPlagiarismConfig = DEFAULT_SELF_PLAGIARISM_CONFIG,
): SelfPlagiarismVerdict {
  const threshold = normalizeThreshold(config.similarityThreshold);
  const candidatePrint = normalizeFingerprint(candidateFingerprint.fingerprint);
  if (candidatePrint === null) {
    return buildVerdict(false, "denied", "missing_candidate_fingerprint");
  }
  if (submissionTimeMs(candidateFingerprint.submittedAt) === null) {
    return buildVerdict(false, "denied", "missing_candidate_submitted_at");
  }

  let bestMatch: OwnSubmissionRecord | undefined;
  let bestSimilarity = 0;
  const nearDuplicates: OwnSubmissionRecord[] = [];

  for (const prior of recentOwnSubmissions) {
    const priorPrint = normalizeFingerprint(prior.fingerprint);
    if (priorPrint === null) continue;
    const similarity = fingerprintSimilarity(candidatePrint, priorPrint);
    if (similarity >= threshold) {
      nearDuplicates.push(prior);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMatch = prior;
      }
    }
  }

  if (nearDuplicates.length === 0) {
    return buildVerdict(true, "allowed", "distinct_from_recent_own_submissions");
  }

  for (const prior of nearDuplicates) {
    if (submissionTimeMs(prior.submittedAt) === null) {
      return buildVerdict(false, "denied", "missing_prior_submitted_at");
    }
  }

  const candidateMember = asClaimMember(candidateFingerprint);
  const siblingMembers = nearDuplicates.map(asClaimMember);
  if (isDuplicateClusterWinnerByClaim(candidateMember, siblingMembers)) {
    return buildVerdict(true, "allowed", "earliest_near_duplicate_claimant");
  }

  const winner =
    resolveDuplicateClusterWinnerNumber(candidateMember, siblingMembers) ??
    bestMatch?.pullRequestNumber ??
    bestMatch?.issueNumber ??
    null;
  const matched =
    bestMatch ??
    nearDuplicates.find(
      (prior) => prior.pullRequestNumber === winner || prior.issueNumber === winner,
    ) ??
    nearDuplicates[0]!;

  const matchedPrint = normalizeFingerprint(matched.fingerprint)!;
  return buildVerdict(
    false,
    "throttled",
    "near_duplicate_self_plagiarism",
    matched,
    bestSimilarity > 0 ? bestSimilarity : fingerprintSimilarity(candidatePrint, matchedPrint),
  );
}

/** Governor-ledger row shape for an open_pr self-plagiarism decision (#2345 deliverable). */
export function buildSelfPlagiarismGovernorLedgerEvent(
  repoFullName: string,
  verdict: SelfPlagiarismVerdict,
): {
  eventType: GovernorLedgerEventType;
  repoFullName: string;
  actionClass: string;
  decision: string;
  reason: string;
  payload: Record<string, unknown>;
} {
  const matched = verdict.matchedSubmission;
  return {
    eventType: verdict.eventType,
    repoFullName,
    actionClass: "open_pr",
    decision: verdict.allowed ? "allow" : verdict.eventType === "throttled" ? "throttle" : "deny",
    reason: verdict.reason,
    payload: matched
      ? {
          matchedRepoFullName: matched.repoFullName,
          matchedPullRequestNumber: matched.pullRequestNumber ?? null,
          matchedIssueNumber: matched.issueNumber ?? null,
          matchedSubmittedAt: matched.submittedAt ?? null,
          similarity: verdict.similarity ?? null,
        }
      : {},
  };
}

/** Normalize a miner-goal-spec selfPlagiarism block (or bare threshold number) into engine config. */
export function resolveSelfPlagiarismConfig(raw: unknown): SelfPlagiarismConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_SELF_PLAGIARISM_CONFIG };
  if (typeof raw === "number") {
    return { similarityThreshold: normalizeThreshold(raw) };
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    return {
      similarityThreshold: normalizeThreshold(
        typeof record.similarityThreshold === "number"
          ? record.similarityThreshold
          : DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD,
      ),
    };
  }
  return { ...DEFAULT_SELF_PLAGIARISM_CONFIG };
}
