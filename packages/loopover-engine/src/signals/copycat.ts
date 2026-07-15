import type { CopycatGateMode } from "../focus-manifest.js";
import type { AdvisoryFinding, AdvisorySeverity } from "../types/predicted-gate-types.js";

// Copycat / plagiarism detection engine (#1969) — the deterministic containment/similarity primitive that
// `gate.copycat.mode` / `gate.copycat.minScore` (parsed end-to-end since #4140, but previously inert) acts on.
// A natural sibling of the deterministic anti-slop signal (./slop.ts) and duplicate-cluster adjudication
// (../duplicate-winner.js): given a PR's ADDED code and a SET of candidate prior-art PRs from the same repo, it
// measures how much of the PR's added code is CONTAINED in each candidate, resolves copy DIRECTION by
// submission timestamp (the earlier submission is the original, never the copier), picks the single
// highest-scoring unambiguous match, and maps the result through the configured tier (warn -> label -> block)
// into a public-safe finding.
//
// PURE / PRECISION-FIRST: no IO, no Date.now(), no randomness -- identical inputs always yield the identical
// verdict. It is deliberately false-accusation-averse: it only ever `wouldAct` when the best-matching
// candidate's score clears the threshold AND that candidate is unambiguously the EARLIER (victim) submission
// AND a non-`off` mode is set. Any missing/ambiguous timestamp, or the candidate being the later work, is
// excluded from consideration entirely -- so an earlier-submitted victim's own later, independent PR (zero
// overlap with anything) evaluates normally, and a tie or unparseable timestamp never accuses anyone.
//
// Fetching the candidate set (earlier open + recently merged/closed PRs on the same repo) and each PR's added
// lines is the caller's responsibility (src/queue/processors.ts) -- this module only scores what it's given.

/** Precision-first default: only a HIGH containment (>= 85% of the PR's added code found in the prior art) trips
 *  the check when `gate.copycat.minScore` is unset. Mirrors the conservative 0.85 spirit of the miner-side
 *  self-plagiarism throttle (governor/self-plagiarism.ts's DEFAULT_SELF_PLAGIARISM_SIMILARITY_THRESHOLD). */
export const DEFAULT_COPYCAT_MIN_SCORE = 85;

/** Shingle width: consecutive normalized lines folded into one token, so containment reflects COPIED PASSAGES
 *  (multi-line runs) rather than incidental single-line coincidences (a lone `}` / `return null;`) that would
 *  inflate a naive line-set overlap. */
const SHINGLE_SIZE = 3;

/** Copy direction between the candidate PR and one prior-art submission, decided purely by submission time. */
export type CopycatDirection = "candidate_copied" | "candidate_is_prior" | "ambiguous";

/** Normalize one source line for structural comparison: collapse internal whitespace runs, trim, lowercase — so
 *  pure reformatting/indentation churn never reads as copied content. */
function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Drop blank/whitespace-only lines and normalize the rest, preserving order. */
function normalizedLines(lines: readonly string[]): string[] {
  return lines.map(normalizeLine).filter((line) => line.length > 0);
}

/** Fold normalized lines into the ORDERED MULTISET of SHINGLE_SIZE-line shingles — duplicates preserved, so a
 *  passage copied twice counts twice toward containment (see {@link containmentScore}, which divides by the
 *  candidate's TOTAL shingle count, not its distinct count). Fewer than SHINGLE_SIZE non-trivial lines collapse
 *  to a single whole-block shingle so tiny snippets still compare (never silently score 0). */
export function codeShingleList(lines: readonly string[]): string[] {
  const normalized = normalizedLines(lines);
  if (normalized.length === 0) return [];
  if (normalized.length < SHINGLE_SIZE) return [normalized.join("\n")];
  const shingles: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= normalized.length; i += 1) {
    shingles.push(normalized.slice(i, i + SHINGLE_SIZE).join("\n"));
  }
  return shingles;
}

/** The DISTINCT SHINGLE_SIZE-line shingles of `lines` — a de-duplicated view of {@link codeShingleList}, used as
 *  the prior-art lookup set (membership only, so duplicates there are irrelevant). */
export function codeShingles(lines: readonly string[]): Set<string> {
  return new Set(codeShingleList(lines));
}

/** Asymmetric containment (0-100): the percentage of the CANDIDATE's added-code shingles that also appear in the
 *  PRIOR ART. Unlike symmetric Jaccard, this answers "how much of THIS PR is copied FROM prior art" without
 *  being diluted by a large prior-art corpus. The candidate is a MULTISET (its total shingle count is the
 *  denominator, so a repeated copied passage is not undercounted), while the prior art is a lookup Set
 *  (membership only) — dividing by the candidate's DISTINCT count instead would undercount a passage copied
 *  more than once. 0 when either side has no comparable content. */
export function containmentScore(candidateLines: readonly string[], priorArtLines: readonly string[]): number {
  const candidate = codeShingleList(candidateLines);
  if (candidate.length === 0) return 0;
  const prior = codeShingles(priorArtLines);
  if (prior.size === 0) return 0;
  let contained = 0;
  for (const shingle of candidate) {
    if (prior.has(shingle)) contained += 1;
  }
  return Math.round((contained / candidate.length) * 100);
}

/** Parse an ISO-8601 submission time to epoch ms; null for a missing/empty/unparseable value. */
function submissionTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Copy direction by submission time: the EARLIER submission is the original, so the LATER one is the potential
 *  copier. Any missing/unparseable timestamp — or an exact tie — is "ambiguous" (fail-safe: never accuse). */
export function copycatDirection(
  candidateAt: string | null | undefined,
  priorAt: string | null | undefined,
): CopycatDirection {
  const candidateMs = submissionTimeMs(candidateAt);
  const priorMs = submissionTimeMs(priorAt);
  if (candidateMs === null || priorMs === null) return "ambiguous";
  if (candidateMs > priorMs) return "candidate_copied";
  if (candidateMs < priorMs) return "candidate_is_prior";
  return "ambiguous";
}

/** Clamp `gate.copycat.minScore` into 0-100; a non-numeric/non-finite value falls back to the engine default. */
function normalizeMinScore(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COPYCAT_MIN_SCORE;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** Per-tier finding severity. `off` never produces a finding (see {@link assessCopycat}); it maps to `info` only
 *  so the lookup is total over {@link CopycatGateMode} without an unreachable branch. */
const MODE_SEVERITY: Record<CopycatGateMode, AdvisorySeverity> = {
  off: "info",
  warn: "info",
  label: "warning",
  block: "critical",
};

/** Public-safe finding — reports the containment score, threshold, and the matched PR's number only (a PR
 *  number is already public on GitHub); never raw code, file names/paths, or any contributor identity. The
 *  caller may sanitize further; this text is already accusation-neutral and contains no scoring internals. */
function buildFinding(mode: CopycatGateMode, score: number, minScore: number, matchedPullNumber: number): AdvisoryFinding {
  return {
    code: "copycat_overlap",
    title: "Potential copied code detected",
    severity: MODE_SEVERITY[mode],
    detail: `This pull request's added code reaches ${score}% containment against prior art in #${matchedPullNumber} (threshold ${minScore}%).`,
    action: "Confirm the overlapping code is original or properly attributed before merging.",
    publicText: `High overlap (${score}%) with earlier prior art in #${matchedPullNumber} — please confirm originality or attribution.`,
  };
}

/** One piece of prior art to compare the candidate PR against — an earlier open, or recently merged/closed, PR
 *  on the same repo. `pullNumber` is used only to name the match publicly (already public on GitHub); it plays
 *  no role in scoring. */
export type CopycatPriorArtCandidate = {
  pullNumber: number;
  lines: readonly string[];
  submittedAt?: string | null | undefined;
};

/** The score/direction of comparing the assessed PR against ONE prior-art candidate — one entry of
 *  {@link CopycatAssessment.matches}, kept for observability even when it doesn't clear the threshold or isn't
 *  the eligible direction. */
export type CopycatMatch = {
  pullNumber: number;
  score: number;
  direction: CopycatDirection;
};

export type CopycatAssessmentInput = {
  /** The PR's ADDED source lines (the candidate). */
  candidateLines: readonly string[];
  /** ISO-8601 submission time of the candidate PR; absent/unparseable ⇒ every comparison is ambiguous. */
  candidateSubmittedAt?: string | null | undefined;
  /** The candidate set of prior-art PRs on the same repo to compare against (caller-fetched; may be empty). */
  priorArt: readonly CopycatPriorArtCandidate[];
  /** `gate.copycat.mode`; `off`/absent ⇒ never acts (scores are still computed for observability). */
  mode?: CopycatGateMode | null | undefined;
  /** `gate.copycat.minScore` (0-100); absent/out-of-range ⇒ {@link DEFAULT_COPYCAT_MIN_SCORE}. */
  minScore?: number | null | undefined;
};

export type CopycatAssessment = {
  /** The best (highest) containment score among every candidate that is unambiguously the EARLIER (prior-art)
   *  submission — i.e. only candidates the PR could actually have copied FROM. 0 when `priorArt` is empty or no
   *  candidate is unambiguously earlier. */
  score: number;
  /** The PR number the best score above came from, or null when there is no eligible (earlier, non-ambiguous)
   *  candidate at all. */
  matchedPullNumber: number | null;
  /** The resolved threshold the score was tested against. */
  minScore: number;
  /** True ONLY when a non-`off` mode is set AND the best eligible score >= threshold. */
  wouldAct: boolean;
  findings: AdvisoryFinding[];
  /** Every candidate's own score/direction, for observability/debugging — NOT public-safe as-is (may reference
   *  PR numbers the caller hasn't otherwise disclosed); the caller decides what (if anything) beyond
   *  {@link findings} to surface. */
  matches: CopycatMatch[];
};

/**
 * Assess one PR's added code against a SET of candidate prior-art PRs from the same repo (#1969). Pure and
 * precision-first: every candidate's score is always computed for observability, but only candidates that are
 * unambiguously EARLIER than the PR (i.e. could actually be the original the PR copied from) are eligible to
 * produce a match or a finding — a later-submitted candidate, a tie, or any missing/unparseable timestamp is
 * excluded from consideration, so the earlier-submitted victim's own later PR is never flagged and an ambiguous
 * comparison never accuses anyone. Among the eligible candidates, the HIGHEST score wins; a finding is emitted
 * only when the configured mode is non-`off` and that best score clears the (resolved) threshold.
 */
export function assessCopycat(input: CopycatAssessmentInput): CopycatAssessment {
  const minScore = normalizeMinScore(input.minScore);
  const mode = input.mode ?? "off";

  const matches: CopycatMatch[] = input.priorArt.map((candidate) => ({
    pullNumber: candidate.pullNumber,
    score: containmentScore(input.candidateLines, candidate.lines),
    direction: copycatDirection(input.candidateSubmittedAt, candidate.submittedAt),
  }));

  let best: CopycatMatch | null = null;
  for (const match of matches) {
    // "candidate_copied" means OUR PR (the candidate) is the LATER submission relative to this prior-art
    // entry — i.e. this entry is genuinely earlier, so it's eligible as the work our PR could have copied
    // FROM. Any other direction (candidate_is_prior = WE are earlier than this entry, or ambiguous) must
    // never be eligible — flagging either would risk accusing the victim instead of the copier.
    if (match.direction !== "candidate_copied") continue;
    if (best === null || match.score > best.score) best = match;
  }

  const score = best?.score ?? 0;
  const matchedPullNumber = best?.pullNumber ?? null;
  const wouldAct = mode !== "off" && best !== null && score >= minScore;

  return {
    score,
    matchedPullNumber,
    minScore,
    wouldAct,
    findings: wouldAct && matchedPullNumber !== null ? [buildFinding(mode, score, minScore, matchedPullNumber)] : [],
    matches,
  };
}

/**
 * Re-derive whether an ALREADY-COMPUTED copycat assessment (persisted `score`/`matchedPullNumber`, e.g.
 * PullRequestRecord.copycatScore/copycatMatchedPullNumber) would act, without re-running the (expensive,
 * candidate-fetching) engine — for a later actuation pass that reads the persisted score back off the PR row
 * instead of the live evaluation that originally computed it (mirrors {@link assessCopycat}'s own wouldAct
 * logic exactly: non-`off` mode, a real match, and the score clearing the resolved threshold).
 */
export function copycatWouldActOnPersistedScore(
  score: number | null | undefined,
  matchedPullNumber: number | null | undefined,
  mode: CopycatGateMode | null | undefined,
  minScore: number | null | undefined,
): boolean {
  if ((mode ?? "off") === "off") return false;
  if (matchedPullNumber === null || matchedPullNumber === undefined) return false;
  if (typeof score !== "number" || !Number.isFinite(score)) return false;
  return score >= normalizeMinScore(minScore);
}
