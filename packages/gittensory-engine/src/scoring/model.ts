import type { ScoringModelSnapshotRecord } from "./types.js";

// Deterministic subset of the backend's `src/scoring/model.ts`, extracted so a miner can run the same
// score-preview constants/classification logic locally (#2282). The upstream-fetching, D1-persisting half
// of that file (`refreshScoringModelSnapshot`, `getOrCreateScoringModelSnapshot`, and their private fetch
// helpers) is Cloudflare/D1-bound and stays in `src/scoring/model.ts`, which imports the pure pieces below
// back from this package.

export const DEFAULT_ISSUE_DISCOVERY_SHARE = 0.5;

export const DEFAULT_SCORING_CONSTANTS: Record<string, number> = {
  OSS_EMISSION_SHARE: 0.9,
  // Upstream name is ISSUES_TREASURY_EMISSION_SHARE (plural). The prior singular spelling never matched
  // upstream, freezing this at the local default and showing up as a false "unmodeled" drift warning (#806).
  ISSUES_TREASURY_EMISSION_SHARE: 0.1,
  // Lookback window used upstream for PR history; stored so it syncs and does not surface as unmodeled drift.
  PR_LOOKBACK_DAYS: 30,
  MERGED_PR_BASE_SCORE: 25,
  // Upstream MAX_CONTRIBUTION_BONUS is 5. This local value is only the fetch-failure fallback; keeping it at
  // 25 silently 5x-inflated the contribution bonus whenever the upstream fetch failed (#807).
  MAX_CONTRIBUTION_BONUS: 5,
  CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
  // Applied in preview.ts when computing totalTokenScore from components (#808).
  TEST_FILE_CONTRIBUTION_WEIGHT: 0.05,
  // Upstream-enforced eligibility floors for PR and issue-discovery history (#808).
  // These gate whether a validator counts a contributor's submissions, not the per-PR/issue score itself.
  // Stored here so they sync from upstream and no longer appear as unmodeled drift warnings.
  MIN_VALID_MERGED_PRS: 3,
  MIN_CREDIBILITY: 0.8,
  MIN_VALID_SOLVED_ISSUES: 3,
  MIN_ISSUE_CREDIBILITY: 0.8,
  MIN_TOKEN_SCORE_FOR_VALID_ISSUE: 5,
  // Open-issue spam gate constants — wired into the issue-discovery scoring lane in preview.ts (#808).
  OPEN_ISSUE_SPAM_BASE_THRESHOLD: 2,
  OPEN_ISSUE_SPAM_TOKEN_SCORE_PER_SLOT: 300,
  MAX_OPEN_ISSUE_THRESHOLD: 30,
  OPEN_PR_COLLATERAL_PERCENT: 0.2,
  MAX_OPEN_PR_REVIEW_COLLATERAL_MULTIPLIER: 2.0,
  MAX_LINES_SCORED_FOR_NON_CODE_EXT: 300,
  DEFAULT_ISSUE_DISCOVERY_SHARE,
  REVIEW_PENALTY_RATE: 0.15,
  STANDARD_ISSUE_MULTIPLIER: 1.33,
  MAINTAINER_ISSUE_MULTIPLIER: 1.66,
  EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
  OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
  MAX_OPEN_PR_THRESHOLD: 30,
  SRC_TOK_SATURATION_SCALE: 58,
  // Density-era constants (#812): upstream is on the saturation model, but `current_density_model` is still
  // a supported `activeModel` (types.ts union, the public OpenAPI schema, the DB parser, ~20 test fixtures,
  // and src/services/score-breakdown.ts). The density branch in preview.ts is therefore NOT dead — it is the
  // supported alternate/fallback model. Single-sourcing these fallbacks HERE (instead of as silent hardcoded
  // literals at every constant() call site) closes the duplicate-source-of-truth gap without a breaking
  // removal of a still-supported model.
  MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
  MAX_CODE_DENSITY_MULTIPLIER: 1.15,
  // Upstream time-decay (#703): a merged PR's score decays on a sigmoid after a grace period. Modeled here
  // so they no longer surface as unmodeled drift (#690); APPLICATION is opt-in + default-off (see preview).
  TIME_DECAY_GRACE_PERIOD_HOURS: 12,
  TIME_DECAY_SIGMOID_MIDPOINT: 10,
  TIME_DECAY_SIGMOID_STEEPNESS_SCALAR: 0.4,
  TIME_DECAY_MIN_MULTIPLIER: 0.05,
};

export const DEFAULT_GITTENSOR_UPSTREAM_REPO = "entrius/gittensor";
export const DEFAULT_GITTENSOR_UPSTREAM_REF = "test";

// Single source of truth (#812): every recognized upstream constant name is a key of
// DEFAULT_SCORING_CONSTANTS, so the known-only parser, the unmodeled-drift detector, and the preview-side
// fallbacks all derive from one place. The density-era constants are included because the density model is
// still a supported activeModel (see comment above). Exported so the D1-bound refresh in
// `src/scoring/model.ts` can reuse it for its `recognizedCount` sanity floor without duplicating the Set.
export const SCORING_CONSTANT_NAMES = new Set(Object.keys(DEFAULT_SCORING_CONSTANTS));

// Mirror Pipeline B's UPSTREAM_STALE_MS (upstream/ruleset.ts): a served scoring snapshot older than this
// window means the last upstream refresh failed or has not run, so previews are quietly using last-good (or
// DEFAULT) constants with no other staleness signal on the scoring side (#810).
export const SCORING_SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;

export function scoringSnapshotStalenessWarning(snapshot: Pick<ScoringModelSnapshotRecord, "fetchedAt">, now: number = Date.now()): string | null {
  if (Date.parse(snapshot.fetchedAt) + SCORING_SNAPSHOT_STALE_MS >= now) return null;
  return "Scoring constants snapshot is stale: the last upstream refresh is older than the freshness window, so scoring may be using last-good or default constants and be behind upstream.";
}

export function parsePythonNumberConstants(source: string, options: { knownOnly?: boolean } = { knownOnly: true }): Record<string, number> {
  const constants: Record<string, number> = {};
  for (const line of source.split("\n")) {
    // Match Python numeric literals including underscore separators in integer and fractional parts
    // (1_000_000, 0.000_001, 3.14_15), floats, and exponents (1e-9, 5.8e1). The previous regex only
    // allowed `_` in the integer part, truncating 0.000_001 -> 0 and 3.14_15 -> 3.14 (#992).
    const match = line.match(/^([A-Z][A-Z0-9_]+)\s*=\s*([-+]?(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][-+]?\d+)?)/);
    if (!match) continue;
    const name = match[1]!;
    const raw = match[2]!;
    if (options.knownOnly !== false && !SCORING_CONSTANT_NAMES.has(name)) continue;
    // Number() rejects underscore separators, so strip them before parsing.
    constants[name] = Number(raw.replace(/_/g, ""));
  }
  return constants;
}

/**
 * Upstream operational/infra constants gittensory intentionally does not model in score previews.
 * They are not scoring dimensions — surfacing them as "unmodeled drift" is noise (#809).
 */
const NON_SCORING_UPSTREAM_CONSTANT_NAMES = new Set([
  "SECONDS_PER_DAY",
  "SECONDS_PER_HOUR",
  "GITHUB_HTTP_TIMEOUT_SECONDS",
  "MIRROR_HTTP_TIMEOUT_SECONDS",
  "MIRROR_MAX_ATTEMPTS",
  "TREE_SITTER_PARSE_TIMEOUT_MICROS",
  "SCORING_SUBPROCESS_BUDGET_S",
  "MAX_FILE_SIZE_BYTES",
  "RECYCLE_UID",
  "ISSUES_TREASURY_UID",
  "MAX_ISSUE_ID",
  // Floating-point epsilon for the registry emission_share-sum validation
  // (load_weights.py: `total_share > 1.0 + EMISSION_SHARE_TOLERANCE`), not a scoring dimension — without
  // this entry the parser (which reads exponent literals like `1e-9`, #992) flagged it as a permanent
  // false-positive unmodeled-scoring-drift warning (#809).
  "EMISSION_SHARE_TOLERANCE",
  // Fallback weight applied by the validator's load_programming_language_weights() for extensions absent from
  // the JSON file; gittensory reads the JSON directly and does not track this loader default (#1692).
  "DEFAULT_PROGRAMMING_LANGUAGE_WEIGHT",
]);

/**
 * Numeric constant names upstream gittensor defines that gittensory's scoring engine does NOT model.
 * The normal parse is `knownOnly` (it keeps only constants we already encode), which silently hides
 * upstream ADDITIONS — e.g. a newly-introduced time-decay constant. Surfacing these makes scoring
 * staleness visible: if upstream adds a scoring dimension, an operator sees it instead of the gate
 * silently drifting behind. Detection only — it does not change any score.
 */
export function findUnmodeledConstantKeys(allConstants: Record<string, number>): string[] {
  return Object.keys(allConstants)
    .filter((name) => !SCORING_CONSTANT_NAMES.has(name) && !NON_SCORING_UPSTREAM_CONSTANT_NAMES.has(name))
    .sort();
}

export function findUnmodeledUpstreamConstants(source: string): string[] {
  return findUnmodeledConstantKeys(parsePythonNumberConstants(source, { knownOnly: false }));
}

/**
 * Owner-controlled global gate for applying upstream time-decay to score previews (#703). Default OFF: the
 * roadmap deferral requires the owner to review a before/after ranking diff before enabling. Even when on,
 * a fresh PR is unaffected (decay 1.0), so it only changes aged-PR projections.
 */
export function isTimeDecayEnabled(env: { SCORING_TIME_DECAY_ENABLED?: string | null | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.SCORING_TIME_DECAY_ENABLED ?? "");
}

export function detectActiveModel(constants: Record<string, number>): ScoringModelSnapshotRecord["activeModel"] {
  if (hasSaturationConstants(constants)) return "pending_saturation_model";
  if (hasDensityConstants(constants)) {
    return "current_density_model";
  }
  return "unknown";
}

// Exported (unlike the backend original, where these stay private) so `src/scoring/model.ts`'s
// D1-bound `refreshScoringModelSnapshot`/`activeModelWarnings` can reuse them without duplication.
export function hasSaturationConstants(constants: Record<string, number>): boolean {
  return Number.isFinite(constants.SRC_TOK_SATURATION_SCALE);
}

export function hasDensityConstants(constants: Record<string, number>): boolean {
  return Number.isFinite(constants.MAX_CODE_DENSITY_MULTIPLIER) && Number.isFinite(constants.MIN_TOKEN_SCORE_FOR_BASE_SCORE);
}
