// Miner kill-switch (#2341): pure resolution of the global + per-repo halt state the Governor chokepoint
// consults FIRST — before any other calculator — to decide whether the miner may perform an autonomous write
// (open_pr / file_issue / comment) on a repo. Mirrors the review-stack's global kill-switch
// (AGENT_ACTIONS_PAUSED, src/settings/agent-execution.ts) for the miner's own local runtime, plus a per-repo
// variant so one misbehaving target can be paused without stopping the whole fleet.
//
// No IO: the global flag is read from GITTENSORY_MINER_KILL_SWITCH and the per-repo set from each repo's
// .gittensory-miner.yml by the caller, which passes them in here; recording a trip to the governor ledger is
// likewise the caller's (separate, maintainer-owned enforcement wiring). This module only DECIDES.

export type KillSwitchState = {
  /** Global halt — when true, ALL miner write activity is denied regardless of per-repo state. */
  global: boolean;
  /** Repos individually halted (each from its own `.gittensory-miner.yml`). */
  haltedRepos: readonly string[];
};

export type KillSwitchScope = "global" | "repo";

export type KillSwitchVerdict = {
  /** True when a write to this repo is currently halted. */
  halted: boolean;
  /** Which switch halted it, or null when nothing is engaged. */
  scope: KillSwitchScope | null;
  reason: string;
};

/** Parse the global kill-switch env value. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`,
 *  same as isOpsEnabled / isSafetyEnabled). Pure. */
export function isGlobalKillSwitchEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? "").trim());
}

/** Normalize a GitHub `owner/repo` for comparison — trimmed + lower-cased (GitHub repo names are
 *  case-insensitive), so a config casing mismatch never lets a halted repo slip through. Pure. */
function normalizeRepoFullName(repoFullName: string): string {
  return repoFullName.trim().toLowerCase();
}

/**
 * Resolve whether a write to `repoFullName` is halted. The GLOBAL switch is checked first and denies
 * regardless of per-repo state; otherwise a per-repo switch denies only its own repo (case-insensitive match).
 * Pure and deterministic.
 */
export function resolveKillSwitch(state: KillSwitchState, repoFullName: string): KillSwitchVerdict {
  if (state.global) {
    return { halted: true, scope: "global", reason: "global kill-switch engaged — all miner write activity halted" };
  }
  const target = normalizeRepoFullName(repoFullName);
  if (state.haltedRepos.some((repo) => normalizeRepoFullName(repo) === target)) {
    return { halted: true, scope: "repo", reason: `per-repo kill-switch engaged for ${repoFullName}` };
  }
  return { halted: false, scope: null, reason: "no kill-switch engaged" };
}

/** Convenience predicate: may the miner write to this repo? Pure. */
export function isMinerWriteAllowed(state: KillSwitchState, repoFullName: string): boolean {
  return !resolveKillSwitch(state, repoFullName).halted;
}
