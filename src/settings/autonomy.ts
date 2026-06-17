import type { AgentActionClass, AutonomyLevel, AutonomyPolicy } from "../types";

// The graduated autonomy dial (#773), ordered least → most autonomous. Every later agent-layer phase reads
// this BEFORE acting. `observe` is the deny-by-default floor — gittensory watches but never takes an action.
export const AUTONOMY_LEVELS = ["observe", "suggest", "propose", "auto_with_approval", "auto"] as const;

// The write-action classes the maintainer auto-maintain layer (#778) can take on a PR.
export const AGENT_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label"] as const;

// Deny-by-default: any action class with no explicit, valid level resolves to this.
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "observe";

const AUTONOMY_LEVEL_SET = new Set<string>(AUTONOMY_LEVELS);

/**
 * Resolve the configured autonomy level for one action class on a repo. THE single gate the action layer
 * (#778) consults before any write action. Deny-by-default: an unset (or malformed) action class is
 * `observe` — gittensory observes but never acts. Pure.
 */
export function resolveAutonomy(autonomy: AutonomyPolicy | null | undefined, actionClass: AgentActionClass): AutonomyLevel {
  return autonomy?.[actionClass] ?? DEFAULT_AUTONOMY_LEVEL;
}

/** True when the level permits the agent to actually execute the action (directly or behind an approval). */
export function isActingAutonomyLevel(level: AutonomyLevel): boolean {
  return level === "auto" || level === "auto_with_approval";
}

/** True when the action must pass a human approval gate (#779) before it executes. */
export function autonomyRequiresApproval(level: AutonomyLevel): boolean {
  return level === "auto_with_approval";
}

/**
 * Parse/validate an arbitrary value into an AutonomyPolicy: keep only known action classes mapped to known
 * levels, drop everything else. Deny-by-default by omission. Used for the DB row, the API body, and the
 * `.gittensory.yml` settings block. Pure.
 */
export function normalizeAutonomyPolicy(input: unknown): AutonomyPolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const policy: AutonomyPolicy = {};
  for (const actionClass of AGENT_ACTION_CLASSES) {
    const value = record[actionClass];
    if (typeof value === "string" && AUTONOMY_LEVEL_SET.has(value)) {
      policy[actionClass] = value as AutonomyLevel;
    }
  }
  return policy;
}
