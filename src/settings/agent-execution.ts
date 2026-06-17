import type { AgentActionClass, AuditEventRecord, AutonomyLevel, AutonomyPolicy } from "../types";
import { isActingAutonomyLevel, resolveAutonomy } from "./autonomy";

// The action classes that mutate a PR's review / merge / close state — these need GitHub `pull_requests: write`.
// (`label` mutates via the Issues API, which the App already holds `issues: write` for.)
const PR_WRITE_ACTION_CLASSES: readonly AgentActionClass[] = ["review", "request_changes", "approve", "merge", "close"];

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
}): AuditEventRecord {
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

export type AgentPermissionReadiness = "not_required" | "ready" | "reconsent_required";

/**
 * Whether the installation grants the write scope the configured auto-maintain actions need (#775). The action
 * layer (#778) consults this before executing a PR-write action: `not_required` = no acting PR-write level is
 * configured; `ready` = the App holds `pull_requests: write`; `reconsent_required` = the maintainer must
 * re-authorize the App with the upgraded permission. Pure.
 */
export function resolveAgentPermissionReadiness(input: { autonomy: AutonomyPolicy | null | undefined; installationPermissions: Record<string, string> | null | undefined }): AgentPermissionReadiness {
  if (!agentRequiresPrWrite(input.autonomy)) return "not_required";
  return input.installationPermissions?.pull_requests === "write" ? "ready" : "reconsent_required";
}
