// ContributionProfile schema constants + tiny pure helpers (#6795). Design/schema only — no extraction logic
// (#6796) and no `discover` wiring (#6798) live here. The shapes are documented in contribution-profile.d.ts
// and packages/loopover-miner/docs/contribution-profile.md; this file exists so the implementation issues have
// concrete, importable constants and the two branch-free helpers they will build on.

/** Bumped when the field set/semantics change, so a cached profile from an older extractor is detectable. */
export const CONTRIBUTION_PROFILE_SCHEMA_VERSION = 1;

/** Confidence vocabulary, weakest-last order used by weakestConfidence. `absent` (the repo has no such signal)
 *  is deliberately distinct from `unknown` (we have not looked / could not tell). */
export const CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS = Object.freeze([
  "explicit",
  "inferred",
  "absent",
  "unknown",
]);

/** The signal sources a rule can be derived from (#6794 found the primary source differs per repo). */
export const CONTRIBUTION_SIGNAL_SOURCES = Object.freeze([
  "labels",
  "contributing_md",
  "pr_template",
  "agent_docs",
]);

/** Default cache TTL: 7 days. Labels/docs change slowly; a week bounds staleness without re-fetching per run. */
export const CONTRIBUTION_PROFILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The local SQLite store table the cache (#6797) will use, named here so the schema owns it. */
export const CONTRIBUTION_PROFILE_STORE_TABLE = "miner_contribution_profile";

/** An `absent` signal rule with no value and no provenance — the safe default for a spine field. */
function absentRule() {
  return { value: null, confidence: "absent", provenance: [] };
}

/**
 * Build an empty, fully-`absent` profile for a repo — the safe default before extraction has run, so `discover`
 * treats an unprofiled repo conservatively rather than as "no restrictions".
 *
 * @param {string} repoFullName
 * @param {string} generatedAt ISO timestamp (passed in rather than read from the clock, so callers/tests stay
 *   deterministic — mirrors how the other miner builders take their timestamp).
 * @returns {import("./contribution-profile.js").ContributionProfile}
 */
export function emptyContributionProfile(repoFullName, generatedAt) {
  return {
    repoFullName,
    schemaVersion: CONTRIBUTION_PROFILE_SCHEMA_VERSION,
    generatedAt,
    eligibilityLabels: absentRule(),
    exclusionLabels: absentRule(),
    prBody: absentRule(),
    completeness: "absent",
  };
}

/**
 * The least-confident of a set of signal confidences — the rule behind a profile's `completeness`. Weakest
 * wins, so one strong signal never masks an absent one. An empty set is `unknown` (nothing observed).
 *
 * @param {readonly string[]} confidences
 * @returns {string}
 */
export function weakestConfidence(confidences) {
  let weakestIndex = -1;
  for (const confidence of confidences) {
    const index = CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS.indexOf(confidence);
    if (index > weakestIndex) weakestIndex = index;
  }
  return weakestIndex === -1
    ? "unknown"
    : CONTRIBUTION_SIGNAL_CONFIDENCE_LEVELS[weakestIndex];
}
