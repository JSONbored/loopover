import type { AgentActionClass, AuditEventRecord, AutonomyLevel, AutonomyPolicy } from "../types";
import { isActingAutonomyLevel, resolveAutonomy } from "./autonomy";

// The action classes that mutate a PR's review / close / head state through Pull Request endpoints. Merge is
// deliberately separate: GitHub's merge endpoint requires `contents: write`, so treating it as only
// `pull_requests: write` lets a repo look ready while the live merge 403s.
// `update_branch` (PUT /pulls/{n}/update-branch) is a PR-write the executor gates; omitting it here graded an
// update_branch-only autonomy "not_required", so the executor's readiness guard denied it even WITH
// pull_requests:write granted (and it would 403 if it slipped). Tests keep the action-specific requirements in
// sync with the executor's exported write-action set. (#audit-update-branch)
const PR_WRITE_ACTION_CLASSES: readonly AgentActionClass[] = ["review", "request_changes", "approve", "close", "update_branch"];
const CONTENTS_WRITE_ACTION_CLASSES: readonly AgentActionClass[] = ["merge"];

export const STRUCTURED_CLOSE_REASONS_MAX_COUNT = 20;

export function boundStructuredCloseReasonsForPersistence<T>(closeReasons: readonly T[]): readonly T[] {
  return closeReasons.length > STRUCTURED_CLOSE_REASONS_MAX_COUNT ? closeReasons.slice(0, STRUCTURED_CLOSE_REASONS_MAX_COUNT) : closeReasons;
}

export type AgentPermissionRequirement = { permission: string; requiredAccess: "write" };

// Whether the agent actually executes an action, only logs what it WOULD do, or is halted entirely (#776).
export type AgentActionMode = "paused" | "dry_run" | "live";

/**
 * The GLOBAL kill-switch — an operator emergency brake (env `AGENT_ACTIONS_PAUSED`) that halts ALL agent
 * actions across every repo, regardless of per-repo config. Same truthy-string idiom as the other env flags.
 */
export function isGlobalAgentPause(env: { AGENT_ACTIONS_PAUSED?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.AGENT_ACTIONS_PAUSED ?? "");
}

/**
 * THE single gate the action layer (#778) consults before executing any action, alongside resolveAutonomy.
 * Precedence (safest wins): a global OR per-repo pause halts everything (`paused`); else a per-repo dry-run
 * logs what would happen without executing (`dry_run`); else `live`. Deny-toward-safety. Pure.
 */
export function resolveAgentActionMode(input: { globalPaused: boolean; agentPaused?: boolean | null | undefined; agentDryRun?: boolean | null | undefined }): AgentActionMode {
  if (input.globalPaused || input.agentPaused === true) return "paused";
  if (input.agentDryRun === true) return "dry_run";
  return "live";
}

/** True only for `live` — the only mode that performs a real GitHub mutation. `paused` does nothing;
 *  `dry_run` records a shadow action but never mutates. */
export function agentActionModeExecutes(mode: AgentActionMode): boolean {
  return mode === "live";
}

/**
 * Build the structured audit record for an agent action (who / what / why / outcome / mode). The action
 * layer passes this to the existing recordAuditEvent so live actions AND dry-run shadows are both recorded
 * on one consistent event shape (#776 "extend the existing audit-event infra"). Pure.
 */
export function buildAgentActionAudit(input: {
  actionClass: AgentActionClass;
  autonomyLevel: AutonomyLevel;
  mode: AgentActionMode;
  outcome: AuditEventRecord["outcome"];
  repoFullName: string;
  targetKey?: string | null | undefined;
  actor?: string | null | undefined;
  reason?: string | null | undefined;
  closeReasons?: readonly string[] | null | undefined;
}): AuditEventRecord {
  const closeReasonCount = input.actionClass === "close" ? (input.closeReasons?.length ?? 0) : 0;
  const closeReasons = closeReasonCount > 0 ? [...boundStructuredCloseReasonsForPersistence(input.closeReasons ?? [])] : null;
  return {
    eventType: `agent.action.${input.actionClass}`,
    actor: input.actor ?? null,
    targetKey: input.targetKey ?? input.repoFullName,
    outcome: input.outcome,
    detail: input.reason ?? null,
    metadata: {
      repoFullName: input.repoFullName,
      actionClass: input.actionClass,
      autonomyLevel: input.autonomyLevel,
      mode: input.mode,
      ...(closeReasons ? { closeReasons, closeReasonCount, ...(closeReasonCount > closeReasons.length ? { closeReasonsTruncated: true } : {}) } : {}),
    },
  };
}

/**
 * True when the repo's autonomy config has any ACTING level (auto / auto_with_approval) for a PR-write action
 * class — i.e. the agent would need GitHub `pull_requests: write` to carry it out (#775). Pure.
 */
export function agentRequiresPrWrite(autonomy: AutonomyPolicy | null | undefined): boolean {
  return PR_WRITE_ACTION_CLASSES.some((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
}

/** True when the configured autonomy can execute a merge, which GitHub authorizes via Contents: write. */
export function agentRequiresContentsWrite(autonomy: AutonomyPolicy | null | undefined): boolean {
  return CONTENTS_WRITE_ACTION_CLASSES.some((actionClass) => isActingAutonomyLevel(resolveAutonomy(autonomy, actionClass)));
}

export type AgentPermissionReadiness = "not_required" | "ready" | "reconsent_required";

function addRequirementOnce(requirements: AgentPermissionRequirement[], requirement: AgentPermissionRequirement): void {
  if (requirements.some((entry) => entry.permission === requirement.permission)) return;
  requirements.push(requirement);
}

export function requiredAgentActionPermissions(
  autonomy: AutonomyPolicy | null | undefined,
  actionClass?: AgentActionClass | null | undefined,
): AgentPermissionRequirement[] {
  const candidates = actionClass ? [actionClass] : [...PR_WRITE_ACTION_CLASSES, ...CONTENTS_WRITE_ACTION_CLASSES];
  const requirements: AgentPermissionRequirement[] = [];
  for (const candidate of candidates) {
    if (!isActingAutonomyLevel(resolveAutonomy(autonomy, candidate))) continue;
    if (PR_WRITE_ACTION_CLASSES.includes(candidate)) addRequirementOnce(requirements, { permission: "pull_requests", requiredAccess: "write" });
    if (CONTENTS_WRITE_ACTION_CLASSES.includes(candidate)) addRequirementOnce(requirements, { permission: "contents", requiredAccess: "write" });
  }
  return requirements;
}

export function missingAgentActionPermissions(input: {
  autonomy: AutonomyPolicy | null | undefined;
  installationPermissions: Record<string, string> | null | undefined;
  actionClass?: AgentActionClass | null | undefined;
}): AgentPermissionRequirement[] {
  return requiredAgentActionPermissions(input.autonomy, input.actionClass).filter(
    (requirement) => input.installationPermissions?.[requirement.permission] !== requirement.requiredAccess,
  );
}

export function formatAgentPermissionDenial(input: {
  autonomy: AutonomyPolicy | null | undefined;
  installationPermissions: Record<string, string> | null | undefined;
  actionClass?: AgentActionClass | null | undefined;
  suppressed?: boolean | undefined;
}): string {
  const missing = missingAgentActionPermissions(input);
  const summary =
    missing.length > 0
      ? missing.map((requirement) => `${requirement.permission}: ${requirement.requiredAccess}`).join(", ")
      : "required GitHub App permission";
  return `${summary} not granted — maintainer must re-consent${input.suppressed ? " (suppressed repeat)" : ""}`;
}

/**
 * Whether the installation grants the write scope the configured auto-maintain actions need (#775). The action
 * layer (#778) consults this before executing a GitHub mutation: `not_required` = no acting level needs a write
 * permission; `ready` = the App holds every required write permission; `reconsent_required` = the maintainer must
 * re-authorize the App with the upgraded permission. Pure.
 */
export function resolveAgentPermissionReadiness(input: {
  autonomy: AutonomyPolicy | null | undefined;
  installationPermissions: Record<string, string> | null | undefined;
  actionClass?: AgentActionClass | null | undefined;
}): AgentPermissionReadiness {
  const required = requiredAgentActionPermissions(input.autonomy, input.actionClass);
  if (required.length === 0) return "not_required";
  return missingAgentActionPermissions(input).length === 0 ? "ready" : "reconsent_required";
}
