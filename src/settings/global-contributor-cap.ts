// Install-wide contributor open-item cap (#2562, anti-abuse): a self-hosted install that gates multiple repos
// shares ONE database, but the per-repo contributorOpenPrCap/contributorOpenIssueCap (repository-settings.ts)
// only ever counts open items on the SAME repo -- an actor spreading low-volume spam/farming PRs across several
// gated repos in that install never trips any single repo's cap. This is cross-REPO-within-one-install only (no
// federation, no cross-instance privacy design): a same-database aggregate against every repo this install
// already tracks. Deliberately an env var (not a per-repo `.gittensory.yml`/DB field like the caps above) --
// this setting aggregates ACROSS repos, so it cannot be "this repo's" setting; it belongs to the install as a
// whole, mirroring how global_contributor_blacklist is a tenant-free singleton rather than a per-repo column.
// Off by default (unset/invalid ⇒ null ⇒ no cap): zero behavior change for a single-repo install or one that
// hasn't opted in.
const GLOBAL_ENV_KEY = "GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP";

/** Parse+validate the install-wide open-item cap from env. Same non-rounding shape as the per-repo caps'
 *  normalizeOpenItemCap (db/repositories.ts): a discrete count of open items, not a score, so a
 *  fractional/non-positive/non-numeric value is a malformed cap and is dropped to `null` (no cap) rather than
 *  coerced into a nonsensical threshold. Never throws. Unlike the per-repo cap, this install-wide cap is not clamped to the
 *  per-repo live-check budget because the install-wide verifier loads and verifies a larger row set. */
export function resolveGlobalContributorOpenItemCap(env: { GLOBAL_CONTRIBUTOR_OPEN_ITEM_CAP?: string | undefined }): number | null {
  const raw = env[GLOBAL_ENV_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
