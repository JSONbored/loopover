import { getRepositorySettings } from "../db/repositories";
import { resolveEffectiveSettings } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import type { RepositorySettings } from "../types";

/** Effective repository settings: DB values overlaid with `.gittensory.yml` (config-as-code). */
export async function resolveRepositorySettings(env: Env, repoFullName: string): Promise<RepositorySettings> {
  const [dbSettings, manifest] = await Promise.all([
    getRepositorySettings(env, repoFullName),
    loadRepoFocusManifest(env, repoFullName),
  ]);
  return resolveEffectiveSettings(dbSettings, manifest);
}
