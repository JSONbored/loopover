// Gittensor experimental-plugin activation wiring. `gittensor` is the first key under the `experimental:`
// manifest block (EXPERIMENTAL_PLUGIN_KEYS) -- gittensory's original subnet mining-registry/scoring
// integration, now an OPT-IN plugin rather than a core dependency, so a self-host instance with no gittensor
// affiliation has zero footprint from it (see registry/sync.ts's self-host scoping, which this feeds, and
// index.ts's cron gate, which skips the registry fetch entirely when nothing is opted in).
//
// Mirrors impact-map-wire.ts's isImpactMapEnabled/shouldComputeImpactMap: a single GLOBAL env kill-switch the
// operator controls, ANDed with an EXPLICIT per-repo `.gittensory.yml experimental.gittensor` manifest `true`
// (resolveManifestOnlyFeature's shape -- no allowlist fallback, unlike the converged `features:` block). Both
// OFF by default: with the env flag unset, no repo is ever treated as gittensor-opted-in. Cloud never consults
// any of this -- registry/sync.ts only calls gittensorEnabledRepoFullNames on the self-host branch, so the
// hosted product's existing full-subnet behavior is untouched.

import { listRepositories } from "../db/repositories";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import { resolveManifestOnlyFeature } from "./feature-activation";

/** True when the gittensor subnet-scoring plugin is enabled at the operator level. Flag-OFF (default) -> no
 *  repo is ever gittensor-opted-in regardless of what any `.gittensory.yml` says, and
 *  {@link gittensorEnabledRepoFullNames} short-circuits before reading a single manifest. Truthy follows the
 *  codebase convention (`/^(1|true|yes|on)$/i`, same as isImpactMapEnabled / isSelfTuneEnabled). */
export function isGittensorPluginEnabled(env: { GITTENSORY_EXPERIMENTAL_GITTENSOR?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_EXPERIMENTAL_GITTENSOR ?? "");
}

/** Resolve whether the gittensor plugin is active for THIS repo: the operator's global env kill-switch AND an
 *  explicit per-repo manifest opt-in. Neither alone is sufficient -- mirrors every other manifestOnly feature
 *  gate in this codebase (env kill-switch first, then the manifest narrows it further). */
export function shouldEnableGittensorForRepo(
  env: { GITTENSORY_EXPERIMENTAL_GITTENSOR?: string | undefined },
  manifestGittensorEnabled: boolean | null | undefined,
): boolean {
  return resolveManifestOnlyFeature(isGittensorPluginEnabled(env), manifestGittensorEnabled);
}

/**
 * The set of repos (lowercased full names) this self-host instance has opted into the gittensor plugin for --
 * every locally-known repo (listRepositories, deliberately NOT filtered by isRegistered: isRegistered is
 * itself DOWNSTREAM of this decision on self-host, see registry/sync.ts's persistRegistrySnapshot, so filtering
 * on it here would be circular -- a repo could never earn its first isRegistered=true) whose manifest sets
 * `experimental.gittensor: true` AND the global env kill-switch is on. A per-repo manifest-load error is
 * skipped (treated as not-opted-in), never aborts the pass -- mirrors selftune-wire.ts's selfTuneRepos.
 * Flag-OFF (default) short-circuits before listing repos or loading a single manifest, so a plain self-host
 * instance makes zero local reads for this and zero outbound gittensor-registry requests (see index.ts).
 */
export async function gittensorEnabledRepoFullNames(env: Env & { GITTENSORY_EXPERIMENTAL_GITTENSOR?: string | undefined }): Promise<Set<string>> {
  if (!isGittensorPluginEnabled(env)) return new Set();
  const repos = await listRepositories(env);
  const enabled = new Set<string>();
  for (const repo of repos) {
    try {
      const manifest = await loadRepoFocusManifest(env, repo.fullName);
      if (shouldEnableGittensorForRepo(env, manifest.experimental.gittensor)) enabled.add(repo.fullName.toLowerCase());
    } catch {
      /* a manifest-load blip on one repo must not block the rest of the pass */
    }
  }
  return enabled;
}
