// Copycat / plagiarism detection engine (#1969) — the deterministic containment/similarity primitive the
// (currently inert) `gate.copycat.mode` / `gate.copycat.minScore` config would act on. A natural sibling of the
// deterministic anti-slop signal (src/signals/slop.ts) and duplicate-cluster adjudication
// (src/signals/duplicate-winner.ts): given a PR's ADDED code and one piece of prior art, it measures how much of
// the PR's added code is CONTAINED in that prior art, resolves copy DIRECTION by submission timestamp (the
// earlier submission is the original, never the copier), and maps the result through the configured tier
// (warn → label → block) into a public-safe finding.
//
// PURE / PRECISION-FIRST: no IO, no Date.now(), no randomness — identical inputs always yield the identical
// verdict. It is deliberately false-accusation-averse: it only ever `wouldAct` when the score clears the
// threshold AND the candidate is unambiguously the LATER (copying) submission AND a non-`off` mode is set. Any
// missing/ambiguous timestamp — or the candidate being the earlier work — resolves to "do not act".
//
// DEFERRED (a later slice of #1969): the gate call-site that feeds a PR's real added-code + prior-art into this
// engine and turns a `wouldAct` verdict into an actual label/block plus the cross-repo "strikes" escalation.
// This slice is the engine + direction + tier mapping only, mirroring how the miner-side self-plagiarism
// throttle (packages/gittensory-engine/src/governor/self-plagiarism.ts) "gates nothing on its own".

import type { AdvisorySeverity, CopycatGateMode } from "../types";
import type { SignalFinding } from "./engine";

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

/** Fold normalized lines into a set of SHINGLE_SIZE-line shingles. Fewer than SHINGLE_SIZE non-trivial lines
 *  collapse to a single whole-block shingle so tiny snippets still compare (never silently score 0). */
export function codeShingles(lines: readonly string[]): Set<string> {
  const normalized = normalizedLines(lines);
  if (normalized.length === 0) return new Set();
  if (normalized.length < SHINGLE_SIZE) return new Set([normalized.join("\n")]);
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= normalized.length; i += 1) {
    shingles.add(normalized.slice(i, i + SHINGLE_SIZE).join("\n"));
  }
  return shingles;
}

/** Asymmetric containment (0-100): the percentage of the CANDIDATE's added-code shingles that also appear in the
 *  PRIOR ART. Unlike symmetric Jaccard, this answers "how much of THIS PR is copied FROM prior art" without being
 *  diluted by a large prior-art corpus. 0 when either side has no comparable content. */
export function containmentScore(candidateLines: readonly string[], priorArtLines: readonly string[]): number {
  const candidate = codeShingles(candidateLines);
  if (candidate.size === 0) return 0;
  const prior = codeShingles(priorArtLines);
  if (prior.size === 0) return 0;
  let contained = 0;
  for (const shingle of candidate) {
    if (prior.has(shingle)) contained += 1;
  }
  return Math.round((contained / candidate.size) * 100);
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

/** Public-safe finding — reports the containment score + threshold only, never raw code, filenames, or any
 *  contributor identity (the caller redacts further; this text is already accusation-neutral). */
function buildFinding(mode: CopycatGateMode, score: number, minScore: number): SignalFinding {
  return {
    code: "copycat_overlap",
    title: "Potential copied code detected",
    severity: MODE_SEVERITY[mode],
    detail: `This pull request's added code reaches ${score}% containment against earlier prior art (threshold ${minScore}%).`,
    action: "Confirm the overlapping code is original or properly attributed before merging.",
    publicText: `High overlap (${score}%) with earlier prior art — please confirm originality or attribution.`,
  };
}

export type CopycatAssessmentInput = {
  /** The PR's ADDED source lines (the candidate). */
  candidateLines: readonly string[];
  /** One piece of prior art's source lines to compare against. */
  priorArtLines: readonly string[];
  /** ISO-8601 submission time of the candidate PR; absent/unparseable ⇒ ambiguous direction (never acts). */
  candidateSubmittedAt?: string | null | undefined;
  /** ISO-8601 submission time of the prior art; absent/unparseable ⇒ ambiguous direction (never acts). */
  priorSubmittedAt?: string | null | undefined;
  /** `gate.copycat.mode`; `off`/absent ⇒ never acts (score is still computed for observability). */
  mode?: CopycatGateMode | null | undefined;
  /** `gate.copycat.minScore` (0-100); absent/out-of-range ⇒ {@link DEFAULT_COPYCAT_MIN_SCORE}. */
  minScore?: number | null | undefined;
};

export type CopycatAssessment = {
  /** Asymmetric containment of the candidate in the prior art, 0-100. */
  score: number;
  direction: CopycatDirection;
  /** The resolved threshold the score was tested against. */
  minScore: number;
  /** True ONLY when a non-`off` mode is set AND score >= threshold AND the candidate is the later (copying) work. */
  wouldAct: boolean;
  findings: SignalFinding[];
};

/**
 * Assess one PR's added code against one piece of prior art (#1969). Pure and precision-first: the containment
 * score is always computed for observability, but a finding is emitted ONLY when the configured mode is non-`off`,
 * the score clears the (resolved) threshold, and the candidate is unambiguously the later submission — so an
 * earlier-submitted victim, or any ambiguous/missing timing, is never flagged.
 */
export function assessCopycat(input: CopycatAssessmentInput): CopycatAssessment {
  const minScore = normalizeMinScore(input.minScore);
  const score = containmentScore(input.candidateLines, input.priorArtLines);
  const direction = copycatDirection(input.candidateSubmittedAt, input.priorSubmittedAt);
  const mode = input.mode ?? "off";
  const wouldAct = mode !== "off" && score >= minScore && direction === "candidate_copied";
  return {
    score,
    direction,
    minScore,
    wouldAct,
    findings: wouldAct ? [buildFinding(mode, score, minScore)] : [],
  };
}
