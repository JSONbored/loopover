import { getInstallation, getPullRequest, getRepositorySettings, getPendingAgentAction, recordAuditEvent, setPendingAgentActionStatus } from "../db/repositories";
import { executeAgentMaintenanceActions, pendingActionToPlanned } from "./agent-action-executor";
import type { AgentPendingActionRecord } from "../types";

export type ApprovalDecision = "accept" | "reject";

export type ApprovalDecisionResult = {
  status: "accepted" | "rejected" | "already_decided" | "not_found";
  action?: AgentPendingActionRecord;
  // For an accept, the executor outcome of running the staged action (completed / denied / error / dry_run).
  executionOutcome?: string;
};

/**
 * Decide a staged approval-queue action (#779). Accept → run the action through the current executor gates
 * (the maintainer's accept IS the approval, so only the approval queue gate is bypassed). Reject → cancel.
 * Either decision marks the row decided (idempotent: a second decision is a no-op) and records an audit event
 * that feeds the trust loop.
 */
export async function decidePendingAgentAction(env: Env, input: { id: string; decision: ApprovalDecision; decidedBy: string }): Promise<ApprovalDecisionResult> {
  const pending = await getPendingAgentAction(env, input.id);
  if (!pending) return { status: "not_found" };
  if (pending.status !== "pending") return { status: "already_decided", action: pending };
  const targetKey = `${pending.repoFullName}#${pending.pullNumber}`;
  const baseMetadata = { pendingId: pending.id, repoFullName: pending.repoFullName, pullNumber: pending.pullNumber, actionClass: pending.actionClass, autonomyLevel: pending.autonomyLevel };

  if (input.decision === "reject") {
    await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
    await recordAuditEvent(env, { eventType: "agent.pending_action.rejected", actor: input.decidedBy, targetKey, outcome: "completed", detail: `rejected ${pending.actionClass}`, metadata: baseMetadata });
    return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy } };
  }

  // accept → execute the staged action live, then record the result.
  const [settings, pr, installation] = await Promise.all([
    getRepositorySettings(env, pending.repoFullName),
    getPullRequest(env, pending.repoFullName, pending.pullNumber),
    getInstallation(env, pending.installationId),
  ]);
  const outcomes = await executeAgentMaintenanceActions(
    env,
    {
      installationId: pending.installationId,
      repoFullName: pending.repoFullName,
      pullNumber: pending.pullNumber,
      headSha: pr?.headSha,
      autonomy: settings.autonomy,
      agentPaused: settings.agentPaused,
      agentDryRun: settings.agentDryRun,
      installationPermissions: installation ? installation.permissions : null,
    },
    [pendingActionToPlanned({ actionClass: pending.actionClass, params: pending.params, reason: pending.reason })],
  );
  /* v8 ignore next -- the executor returns one outcome per planned action, so the fallback is defensive. */
  const execOutcome = outcomes[0]?.outcome ?? "no_outcome";
  await setPendingAgentActionStatus(env, pending.id, { status: "accepted", decidedBy: input.decidedBy });
  await recordAuditEvent(env, {
    eventType: "agent.pending_action.accepted",
    actor: input.decidedBy,
    targetKey,
    outcome: execOutcome === "completed" ? "completed" : "error",
    detail: `accepted ${pending.actionClass} → ${execOutcome}`,
    metadata: { ...baseMetadata, executionOutcome: execOutcome },
  });
  return { status: "accepted", action: { ...pending, status: "accepted", decidedBy: input.decidedBy }, executionOutcome: execOutcome };
}
