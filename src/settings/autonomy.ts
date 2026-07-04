import type { AgentActionClass, AutoMaintainPolicy, AutoMergeMethod, AutonomyLevel, AutonomyPolicy } from "../types";

// The graduated autonomy dial (#773), ordered least → most autonomous. Every later agent-layer phase reads
// this BEFORE acting. `observe` is the deny-by-default floor — gittensory watches but never takes an action.
export const AUTONOMY_LEVELS = ["observe", "suggest", "propose", "auto_with_approval", "auto"] as const;

// The write-action classes the maintainer auto-maintain layer (#778) can take on a PR. `review_state_label`
// (#label-scoping) is a separate class from `label`: it gates the planner's own disposition-communication
// labels (ready-to-merge / changes-requested / manual-review / migration-collision / pending-closure /
// new-account), independent of the anti-abuse enforcement labels (blacklist/contributor-cap/review-nag), which
// ride on `close` instead -- see agent-actions.ts.
export const AGENT_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label", "review_state_label", "update_branch"] as const;

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

/**
 * True when a repo has opted into the agent layer at all — i.e. at least one action class has an acting
 * autonomy level. The deny-by-default floor (every class `observe`) is NOT configured. The scheduled
 * re-gate sweep (#777) uses this to skip repos that never asked the agent to act. Pure.
 */
export function isAgentConfigured(autonomy: AutonomyPolicy | null | undefined): boolean {
  return AGENT_ACTION_CLASSES.some((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
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

// Auto-maintain policy (#774): how an action behaves once its autonomy level permits acting.
export const AUTO_MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const AUTO_MERGE_METHOD_SET = new Set<string>(AUTO_MERGE_METHODS);

// Conservative defaults: squash (the tidiest history) + a single human approval before any auto-merge.
export const DEFAULT_AUTO_MAINTAIN_POLICY: AutoMaintainPolicy = { requireApprovals: 1, mergeMethod: "squash" };

// Approvals are clamped to a sane band so a malformed config can't disable the gate (negative) or stall it.
const MAX_REQUIRE_APPROVALS = 10;

/**
 * Parse/validate an arbitrary value into an AutoMaintainPolicy, filling the conservative defaults for any
 * missing/invalid field. `requireApprovals` is clamped to [0, 10]. Pure.
 */
export function normalizeAutoMaintainPolicy(input: unknown): AutoMaintainPolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ...DEFAULT_AUTO_MAINTAIN_POLICY };
  const record = input as Record<string, unknown>;
  const rawApprovals = record.requireApprovals;
  const requireApprovals =
    typeof rawApprovals === "number" && Number.isFinite(rawApprovals)
      ? Math.min(MAX_REQUIRE_APPROVALS, Math.max(0, Math.trunc(rawApprovals)))
      : DEFAULT_AUTO_MAINTAIN_POLICY.requireApprovals;
  const rawMethod = record.mergeMethod;
  const mergeMethod = typeof rawMethod === "string" && AUTO_MERGE_METHOD_SET.has(rawMethod) ? (rawMethod as AutoMergeMethod) : DEFAULT_AUTO_MAINTAIN_POLICY.mergeMethod;
  return { requireApprovals, mergeMethod };
}
