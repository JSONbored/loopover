// The set of repositories a fleet-wide pass should consider (#10170).
//
// Assembling this was duplicated FIVE times, byte-identical: three copies inside queue/processors.ts and one
// each in review/pr-reconciliation.ts and review/sweep-watchdog.ts. Every fleet-wide sweep needs the same
// answer to "which repos are in scope", and every one of them rebuilt it.
//
// Only the ASSEMBLY is shared. What each caller then does with the set -- resolving settings, requiring a
// real installation, applying its own eligibility rule -- genuinely differs and deliberately stays at the
// call site. Extracting more than this would force the callers' differences into flag parameters, which is
// how a shared helper becomes worse than the duplication it replaced.
//
// Two sources are merged, and the ORDER matters: the convergence list wins. A repo named there is in scope
// whether or not it has a local row, and when it has one, the row's installationId is carried over so a
// caller that requires a real GitHub App installation can still tell. A locally-known repo absent from the
// convergence list keeps its row as-is.

import { listRepositories } from "../db/repositories";
import { listConvergenceRepos } from "./cutover-gate";

/** A repo in scope for a fleet-wide pass. `installationId` is absent -- not null -- when unknown, matching
 *  the exactOptionalPropertyTypes shape every existing call site already spreads. */
export type ConfiguredRepoCandidate = { fullName: string; installationId?: number };

/**
 * Every repository a fleet-wide pass should consider: locally-known rows plus the convergence allowlist,
 * de-duplicated case-insensitively on the full name.
 *
 * Callers apply their own eligibility on top -- this deliberately does NOT decide whether a repo is
 * agent-configured, installed, or due. It answers only "which repos exist for this pass".
 */
export async function resolveConfiguredRepoCandidates(env: Env): Promise<ConfiguredRepoCandidate[]> {
  const repositoriesByKey = new Map((await listRepositories(env)).map((repo) => [repo.fullName.toLowerCase(), repo]));
  const byKey = new Map<string, ConfiguredRepoCandidate>();
  for (const repo of repositoriesByKey.values())
    byKey.set(repo.fullName.toLowerCase(), { fullName: repo.fullName, ...(typeof repo.installationId === "number" ? { installationId: repo.installationId } : {}) });
  for (const fullName of listConvergenceRepos(env)) {
    const repo = repositoriesByKey.get(fullName.toLowerCase());
    byKey.set(fullName.toLowerCase(), {
      fullName,
      ...(typeof repo?.installationId === "number" ? { installationId: repo.installationId } : {}),
    });
  }
  return [...byKey.values()];
}
