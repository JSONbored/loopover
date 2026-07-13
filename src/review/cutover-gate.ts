// Convergence (cutover) per-repo gate: an allowlist that activates the PER-PR converged review features one
// repo at a time, so the cutover can be rolled forward (and rolled back) on a single repo without flipping the
// global flags off for everyone. Each per-PR converged feature ALREADY has a global switch (GITTENSORY_REVIEW_SAFETY /
// _GROUNDING / _RAG / _REPUTATION, GITTENSORY_REVIEW_UNIFIED_COMMENT); this adds a SECOND, repo-scoped gate that must
// ALSO pass for the feature to run on a given PR's repo.
//
// Single env var: GITTENSORY_REVIEW_REPOS — a comma-separated allowlist of repo full-names
// ("owner/repo", e.g. "JSONbored/gittensory,JSONbored/awesome-claude"). A repo activates the converged
// features ONLY IF (the feature's global flag is ON) AND (the repo is in this allowlist).
//
// DEFAULT IS NO REPOS: empty / unset / whitespace-only → false for EVERY repo. So even with every global flag
// ON, the per-PR converged path stays dormant (byte-identical to today) until a repo is explicitly listed.
// This is deliberately the OPPOSITE default of an empty=all allowlist — the safe state is "nothing converged".
//
// Matching is case-insensitive exact match on the trimmed "owner/repo" (GitHub repo full-names are
// case-insensitive). Empty entries between commas are ignored, so a trailing/stray comma is harmless.

import { dualPrefixEnvString } from "../utils/env";

/**
 * True when `repoFullName` is in the GITTENSORY_REVIEW_REPOS allowlist (per-repo cutover gate).
 *
 * - Splits the allowlist on commas, trims each entry, and does a case-insensitive exact match on "owner/repo".
 * - Empty / unset / whitespace-only allowlist → ALWAYS false (no repos converged — the dormant default).
 * - An empty / whitespace-only `repoFullName` → false (never matches an empty allowlist entry).
 *
 * Callers AND this with the feature's existing global flag (e.g. `isSafetyEnabled(env) &&
 * isConvergenceRepoAllowed(env, repo)`), so a feature runs only when BOTH the global flag is ON and the repo is
 * allowlisted.
 */
export function isConvergenceRepoAllowed(
  env: { GITTENSORY_REVIEW_REPOS?: string | undefined; LOOPOVER_REVIEW_REPOS?: string | undefined },
  repoFullName: string,
): boolean {
  const target = repoFullName.trim().toLowerCase();
  if (!target) return false;
  const raw = dualPrefixEnvString(env as unknown as Record<string, string | undefined>, "REVIEW_REPOS") ?? "";
  for (const entry of raw.split(",")) {
    const candidate = entry.trim().toLowerCase();
    if (candidate && candidate === target) return true;
  }
  return false;
}

/**
 * The configured GITTENSORY_REVIEW_REPOS as a deduped list of "owner/repo" full-names (original case preserved,
 * deduped case-insensitively, empty entries dropped). Empty when unset.
 *
 * Used to PROACTIVELY index a self-host maintainer's repos for RAG even when they were never registered via a
 * webhook (the brokered model leaves is_registered=0), so a maintainer's whole repo set is pre-indexed for
 * codebase-aware reviews instead of waiting for a cold first-PR index.
 */
export function listConvergenceRepos(env: {
  GITTENSORY_REVIEW_REPOS?: string | undefined;
  LOOPOVER_REVIEW_REPOS?: string | undefined;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const raw = dualPrefixEnvString(env as unknown as Record<string, string | undefined>, "REVIEW_REPOS") ?? "";
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
