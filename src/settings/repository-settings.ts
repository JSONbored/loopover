import { getGlobalContributorBlacklist, getRepositorySettings } from "../db/repositories";
import { loadOverride, type StorageEnv } from "../review/auto-apply";
import { resolveEffectiveSettings } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
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

/** Effective repository settings: DB values overlaid with `.gittensory.yml` (config-as-code), then — when the
 *  self-improvement loop is enabled (`LOOPOVER_REVIEW_SELFTUNE`, default OFF) — with the repo's promoted,
 *  soak-passed, tightening-only auto-tune override. Flag-OFF (default) ⇒ no override read, byte-identical to before. */
export async function resolveRepositorySettings(env: Env, repoFullName: string): Promise<RepositorySettings> {
  const [dbSettings, manifest, globalContributorBlacklist] = await Promise.all([
    getRepositorySettings(env, repoFullName),
    loadRepoFocusManifest(env, repoFullName),
    getGlobalContributorBlacklist(env).catch(() => []),
  ]);
  const effective = resolveEffectiveSettings(dbSettings, manifest, globalContributorBlacklist);
  if (!selfTuneFlagOn(env)) return effective;
  // loadOverride is internally fail-safe (returns null on a DB blip), so this never breaks settings resolution.
  const override = await loadOverride(env as unknown as StorageEnv, repoFullName);
  return applySelfTuneOverrideToSettings(effective, override);
}
