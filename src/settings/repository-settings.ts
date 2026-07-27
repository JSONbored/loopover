import { getGlobalContributorBlacklist, getRepository, getRepositorySettings } from "../db/repositories";
import { loadOverride, type StorageEnv } from "../review/auto-apply";
import { resolveEffectiveSettings } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { isAgentConfigured } from "./autonomy";
import { resolveEffectiveCopycatGateMode } from "./copycat-gate-mode";
import type { RepositorySettings } from "../types";

/** Default-OFF self-tune flag (mirrors selftune-wire's `isSelfTuneEnabled`; inlined here to avoid a
 *  selftune-wire → repository-settings → selftune-wire import cycle). */
function selfTuneFlagOn(env: { LOOPOVER_REVIEW_SELFTUNE?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_REVIEW_SELFTUNE ?? "").trim());
}

/** PURE: overlay a promoted (always TIGHTENING-only) self-tune override onto resolved settings. The auto-tune's
 *  `confidenceFloor` [0,1] is translated to a readiness-score floor [0,100] and applied as a `max()`, so it can
 *  ONLY RAISE an EXISTING `qualityGateMinScore` — never CREATE one (a repo with no readiness threshold keeps
 *  none, respecting the operator's choice) and never LOWER it. No override / no floor / no existing threshold /
 *  a floor at-or-below the current ⇒ settings are returned unchanged. This is the live read-back of the loop
 *  that `auto-apply.ts` shadow-soaks + promotes into `tunables_overrides` (the read-back was previously deferred). */
export function applySelfTuneOverrideToSettings(
  settings: RepositorySettings,
  override: { confidenceFloor?: number | undefined } | null,
): RepositorySettings {
  const floor = override?.confidenceFloor;
  if (floor === undefined) return settings; // no override / no promoted floor
  const current = settings.qualityGateMinScore;
  if (typeof current !== "number") return settings; // never CREATE a readiness gate the operator didn't set
  const floorScore = Math.max(0, Math.min(100, Math.round(floor * 100)));
  return floorScore > current ? { ...settings, qualityGateMinScore: floorScore } : settings; // raise only
}

/** Effective repository settings: DB values overlaid with `.loopover.yml` (config-as-code), then — when the
 *  self-improvement loop is enabled (`LOOPOVER_REVIEW_SELFTUNE`, default OFF) — with the repo's promoted,
 *  soak-passed, tightening-only auto-tune override. Flag-OFF (default) ⇒ no override read, byte-identical to before.
 *
 *  The override read-back honors the SAME two consent signals `selfTuneRepos` (`review/selftune-wire.ts`) checks
 *  before ever generating a new recommendation: an explicit per-repo `.loopover.yml` `review.selftune: false`
 *  opt-out, and the repo's broader acting-autonomy consent (`isAgentConfigured`). Without this, a repo that
 *  opts out (or has its autonomy fully revoked) AFTER an override was already promoted would keep having that
 *  stale override silently reapplied to every gate decision forever — the only escape hatch would be the
 *  maintainer-only DELETE override route, which nothing surfaces to the operator. Opting out here does NOT
 *  delete the promoted override (a human, or re-opting-in, can still see/clear it) — it just stops it from
 *  being read back while the opt-out is in effect. */
export async function resolveRepositorySettings(env: Env, repoFullName: string): Promise<RepositorySettings> {
  const [dbSettings, manifest, globalContributorBlacklist, repo] = await Promise.all([
    getRepositorySettings(env, repoFullName),
    loadRepoFocusManifest(env, repoFullName),
    getGlobalContributorBlacklist(env).catch(() => []),
    // #9033: cheap, indexed single-row read (mirrors the three parallel reads above) purely to resolve the
    // copycat-gate reward-eligibility default below -- never throws (getRepository resolves null, not rejects,
    // for a repo LoopOver hasn't seen), so a lookup failure just means "not registered" (today's "off" default).
    getRepository(env, repoFullName),
  ]);
  const effective = resolveEffectiveSettings(dbSettings, manifest, globalContributorBlacklist);
  // #9033: reward-eligible default flip -- an EXPLICIT `.loopover.yml` value (including an explicit "off") always
  // wins; only a genuinely unset value falls through to the registration-based default. Applied to every return
  // path below (not just the fast path) since this must hold whether or not self-tune is enabled.
  effective.copycatGateMode = resolveEffectiveCopycatGateMode(effective.copycatGateMode, repo?.isRegistered ?? false);
  if (!selfTuneFlagOn(env)) return effective;
  if (manifest.review.selftune === false) return effective; // explicit per-repo opt-out — same check as selfTuneRepos
  if (!isAgentConfigured(effective.autonomy)) return effective; // acting-autonomy consent revoked/never granted
  // loadOverride is internally fail-safe (returns null on a DB blip), so this never breaks settings resolution.
  const override = await loadOverride(env as unknown as StorageEnv, repoFullName);
  return applySelfTuneOverrideToSettings(effective, override);
}
