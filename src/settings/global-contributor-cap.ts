// Install-wide contributor open-item cap (#2562, anti-abuse): a self-hosted install that gates multiple repos
// shares ONE database, but the per-repo contributorOpenPrCap/contributorOpenIssueCap (repository-settings.ts)
// only ever counts open items on the SAME repo -- an actor spreading low-volume spam/farming PRs across several
// gated repos in that install never trips any single repo's cap. This is cross-REPO-within-one-install only (no
// federation, no cross-instance privacy design): a same-database aggregate against every repo this install
// already tracks. Deliberately an env var (not a per-repo `.gittensory.yml`/DB field like the caps above) --
// this setting aggregates ACROSS repos, so it cannot be "this repo's" setting; it belongs to the install as a
// whole, mirroring how global_contributor_blacklist is a tenant-free singleton rather than a per-repo column.
//
// #4511 (AMS-readiness follow-up): "unset ⇒ null ⇒ no cap" was the ONLY defense against one identity farming
// PRs across every gated repo in an install, and it was off unless an operator proactively opted in AND
// remembered to pre-size it. That's backwards for a fleet-scale actor -- fail-safe means a sane cap exists by
// default, not that protection is silently absent until someone configures it. So: unset/malformed now falls
// back to a real default (DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP) rather than "no cap" -- this IS a behavior
// change for any install that never set the env var. An operator who genuinely wants no cap sets the env var
// to the literal string "off" (a load-bearing explicit opt-out, distinct from "unset"), mirroring the
// explicit-null-means-something idiom used elsewhere in this codebase (e.g. blacklistLabel).
const GLOBAL_ENV_KEY = "GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP";
const GLOBAL_MINER_ENV_KEY = "GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER";
const OFF_SENTINEL = "off";

/** Default install-wide cap for a non-miner actor when {@link GLOBAL_ENV_KEY} is unset or malformed (#4511). */
export const DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP = 20;
/** Default install-wide cap for a CONFIRMED official Gittensor miner (#4511): higher than the human default
 *  because a legitimate fleet spread across many repos in one install is expected to run more concurrent open
 *  items than a single human contributor, without being unlimited. Applies ONLY once the author is verified
 *  via the same official-miner-detection path the rest of the codebase already trusts for this purpose
 *  (getCachedOfficialMinerDetection) -- an unverified/unconfirmed actor always gets the human default. */
export const DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER = 50;

function resolveCapEnv(raw: string | undefined, fallback: number): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  if (raw.trim().toLowerCase() === OFF_SENTINEL) return null;
  const parsed = Number(raw);
  // A malformed value (fractional/non-positive/non-numeric) falls back to the SAME default an unset env var
  // would use, not to "no cap" -- a typo in an operator's .env must never silently disable this defense.
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Resolve the install-wide open-item cap for an ordinary (non-miner) actor. `null` means explicitly disabled
 *  (env var set to `"off"`) -- everything else, including unset, resolves to a real number. Never throws.
 *  Unlike the per-repo cap, this install-wide cap is not clamped to the per-repo live-check budget because the
 *  install-wide verifier loads and verifies a larger row set. */
export function resolveGlobalContributorOpenItemCap(env: { GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP?: string | undefined }): number | null {
  return resolveCapEnv(env[GLOBAL_ENV_KEY], DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP);
}

/** Resolve the install-wide open-item cap for a CONFIRMED official Gittensor miner (#4511) -- same shape and
 *  `"off"` escape hatch as {@link resolveGlobalContributorOpenItemCap}, but with a fleet-appropriate default.
 *  Callers must only use this once the actor's miner status is independently verified; this function does not
 *  itself check identity. */
export function resolveGlobalContributorOpenItemCapForMiner(env: { GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER?: string | undefined }): number | null {
  return resolveCapEnv(env[GLOBAL_MINER_ENV_KEY], DEFAULT_GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP_MINER);
}
