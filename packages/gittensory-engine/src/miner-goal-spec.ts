// MinerGoalSpec (#2293). The type surface for `.gittensory-miner.yml` — the per-repo config a maintainer/repo-owner
// drops in to tell an autonomous miner what to look for and how to behave when targeting their repo. This is the
// MINER-side analogue of the review-side `.gittensory.yml` focus manifest (see `src/signals/focus-manifest.ts`'s
// `FocusManifest`): a small typed config object paired with an explicit safe-defaults constant.
//
// This module is TYPES ONLY — no parsing, no IO. The parser (validation + safe-default coercion of raw YAML) is a
// separate follow-up issue; keeping the shape small here is deliberate, because it is easy to add a field later and
// painful to remove one contributors already rely on. Field names/semantics that overlap the review side are
// carried over verbatim from `.gittensory.yml` so the two manifests stay obviously paired.

/** How strongly opening discovery issues is encouraged for this repo. Mirrors the review-side policy vocabulary. */
export type MinerIssueDiscoveryPolicy = "encouraged" | "neutral" | "discouraged";

/** Per-repo miner configuration parsed from `.gittensory-miner.yml`. See {@link DEFAULT_MINER_GOAL_SPEC}. */
export type MinerGoalSpec = {
  /**
   * Whether this repo permits autonomous miners at all. Explicit OPT-OUT, not opt-in: a public repo with no
   * `.gittensory-miner.yml` is still minable, mirroring `.gittensory.yml`'s "safe by default" stance. Set `false`
   * to halt all miner targeting of this repo. Default: true.
   */
  minerEnabled: boolean;
  /**
   * Work areas the maintainer wants a miner to focus on; a candidate touching these is preferred. Glob list.
   * Default: [] (no preference).
   */
  wantedPaths: readonly string[];
  /**
   * Paths off-limits to a miner. A candidate touching one of these should be skipped. Glob list.
   * Default: [] (nothing blocked).
   */
  blockedPaths: readonly string[];
  /**
   * Issue/PR labels the maintainer prefers a miner to target; a candidate carrying one is favored. String list.
   * Default: [] (no preference).
   */
  preferredLabels: readonly string[];
  /**
   * Maximum number of issues a single miner may hold claimed on this repo at once, so one miner cannot monopolize
   * a repo's queue. A positive integer (`>= 1`); the parser is expected to floor a non-integer toward zero
   * (`Math.floor`) and reject any value below 1. Default: 1.
   */
  maxConcurrentClaims: number;
  /**
   * How strongly this repo encourages a miner to open discovery issues. Values: encouraged | neutral | discouraged.
   * Default: neutral.
   */
  issueDiscoveryPolicy: MinerIssueDiscoveryPolicy;
};

/**
 * The safe defaults applied when a field is absent from `.gittensory-miner.yml` (or the file itself is missing).
 * Every value here matches the "Default: X" documented on its field above. Analogous to the defaults constant that
 * accompanies `FocusManifest` in `src/signals/focus-manifest.ts` — a repo with no file behaves as if it declared
 * this: minable, with no path/label preferences, one concurrent claim, and neutral discovery.
 *
 * Deep-frozen: this is a shared singleton, so runtime code can read it freely but must not mutate it — clone before
 * layering repo-specific overrides on top.
 */
export const DEFAULT_MINER_GOAL_SPEC: Readonly<MinerGoalSpec> = Object.freeze({
  minerEnabled: true,
  wantedPaths: Object.freeze([]),
  blockedPaths: Object.freeze([]),
  preferredLabels: Object.freeze([]),
  maxConcurrentClaims: 1,
  issueDiscoveryPolicy: "neutral",
});
