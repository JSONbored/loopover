import type { CopycatGateMode } from "../types";

/**
 * #9033: the copycat/plagiarism containment gate (`gate.copycat.mode`) is config-as-code only (no DB column,
 * see {@link RepositorySettings.copycatGateMode}'s own doc comment) and its absent-value fallback was a flat
 * "off" for every repo -- so a repo only ever got copycat/reward-farming protection if it explicitly opted in
 * via its own `.loopover.yml`. Two colluding accounts (or one attacker with two identities) filing near-identical
 * fixes under different linked issues could both merge and both earn Gittensor rewards, with nothing evaluating
 * the content-similarity signal at all by default.
 *
 * This mirrors `resolveDuplicateWinnerEnabled` (settings/duplicate-winner-mode.ts)'s own inherit-vs-explicit
 * shape: an EXPLICIT per-repo value (including an explicit "off") always wins outright, and only a genuinely
 * UNSET value (the manifest never mentioned `gate.copycat.mode` at all) falls through to a resolved default --
 * except here the default itself is conditional on reward-eligibility rather than a single global flag, since
 * `LOOPOVER_DUPLICATE_WINNER`-style env flags have no per-repo economic dimension to key off of, while copycat
 * reward-farming specifically only pays out on a repo that actually earns Gittensor rewards.
 */

/** Reward-eligible default tier (#9033): `warn` is the least destructive tier that still turns ON the
 *  deterministic containment engine (src/queue/copycat-detection.ts) for a reward-eligible repo that never
 *  configured `gate.copycat.mode` at all -- it surfaces the advisory finding and (critically) makes the engine
 *  persist `copycatScore`/`copycatMatchedPullNumber` on every PR, which is what the duplicate-cluster election
 *  (src/queue/duplicate-detection.ts, src/rules/advisory.ts's `duplicate_pr_risk` finding) needs to catch a
 *  cross-issue content match at all. It deliberately stops short of `label`/`block` as the DEFAULT: those tiers
 *  take a unilateral, single-PR action (a label, or an outright close) off a 3-line-shingle containment
 *  heuristic with no observed false-positive rate yet on a repo that never asked for this gate. A maintainer who
 *  wants the stronger tiers can still set `gate.copycat.mode: label`/`block` explicitly -- this default never
 *  overrides that choice (see {@link resolveEffectiveCopycatGateMode}). The actual cross-issue reward-farming
 *  close still happens even at `warn`, via the duplicate-cluster election path, which only needs a persisted
 *  score/match to exist -- not `copycatGateMode` at `label`/`block`. */
export const DEFAULT_COPYCAT_GATE_MODE_FOR_REGISTERED_REPO: CopycatGateMode = "warn";

/**
 * Resolve the EFFECTIVE `copycatGateMode` (#9033): an explicit value (from `.loopover.yml`'s `settings:` block or
 * its `gate.copycat.mode` alias -- `copycatGateMode` has no DB column, so a defined value here can only have come
 * from config-as-code) always wins, even an explicit `"off"`. Only a genuinely UNSET value (`null`/`undefined` --
 * the manifest never mentioned it) falls through to the reward-eligibility default: `isRegistered` (subnet-
 * registered, i.e. this repo's merged PRs actually earn Gittensor rewards -- see `RepositoryRecord.isRegistered`,
 * the same flag `registry/sync.ts` sets when a repo is present in the latest registry snapshot) resolves to
 * {@link DEFAULT_COPYCAT_GATE_MODE_FOR_REGISTERED_REPO}; an unregistered repo keeps today's "off" default
 * unchanged (self-host / not-yet-registered / de-registered repos see byte-identical behavior).
 */
export function resolveEffectiveCopycatGateMode(mode: CopycatGateMode | null | undefined, isRegistered: boolean): CopycatGateMode {
  if (mode !== null && mode !== undefined) return mode;
  return isRegistered ? DEFAULT_COPYCAT_GATE_MODE_FOR_REGISTERED_REPO : "off";
}
