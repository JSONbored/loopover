import { bumpPullRequestMergeAttempt, createPendingAgentActionIfAbsent, insertNotificationDeliveryIfAbsent, markPullRequestMergeBlocked, recordAuditEvent } from "../db/repositories";
import { classifyMergeFailure, MERGE_RETRY_CAP } from "./merge-failure";
import { notifyActionToDiscord, type NotifyOutcome } from "./notify-discord";
import { ensurePullRequestLabel } from "../github/labels";
import { closePullRequest, createIssueComment, createPullRequestReview, mergePullRequest } from "../github/pr-actions";
import { isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { buildAgentActionAudit, isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import type { PlannedAgentAction } from "../settings/agent-actions";
import type { AgentActionClass, AgentPendingActionParams, AutonomyLevel, AutonomyPolicy } from "../types";
import { errorMessage } from "../utils/json";

// The agent actor name on every audit record — the App acts on the maintainer's behalf per their configured
// autonomy (the config IS the authorization; there is no human commenter to authorize, unlike #824).
const AGENT_ACTOR = "gittensory";

// The PR-state action classes that require GitHub `pull_requests: write`. `label` mutates via the Issues API
// (`issues: write`, always held), so it is exempt from the write-permission readiness gate.
const PR_WRITE_CLASSES = new Set<AgentActionClass>(["request_changes", "approve", "merge", "close"]);

export type AgentActionExecutionContext = {
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha?: string | null | undefined;
  autonomy: AutonomyPolicy | null | undefined;
  agentPaused?: boolean | undefined;
  agentDryRun?: boolean | undefined;
  installationPermissions: Record<string, string> | null | undefined;
  // PR author login — surfaced as the "Submitter" in the per-repo Discord action notification.
  authorLogin?: string | null | undefined;
};

export type AgentActionOutcome = {
  actionClass: AgentActionClass;
  outcome: "completed" | "queued" | "denied" | "error" | "dry_run";
  detail: string;
};

/**
 * Execute (or dry-run, or stage for approval) a planned auto-maintain action set on one PR. Each action runs
 * through the SAME deny-toward-safety gate stack before any GitHub call:
 *   pause (#776 kill-switch) → current autonomy → approval (auto_with_approval → #779 queue) → write-permission (#775) → mode.
 * Only `live` mode performs a real mutation; `dry_run` records what it WOULD do. Every path writes one
 * `agent.action.<class>` audit record (#776). A failed mutation is recorded as `error`, never swallowed.
 */
export async function executeAgentMaintenanceActions(env: Env, ctx: AgentActionExecutionContext, planned: PlannedAgentAction[]): Promise<AgentActionOutcome[]> {
  const outcomes: AgentActionOutcome[] = [];
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

  for (const action of planned) {
    const autonomyLevel = resolveAutonomy(ctx.autonomy, action.actionClass);
    const audit = (outcome: AgentActionOutcome["outcome"], detail: string) => {
      const auditOutcome = outcome === "dry_run" ? "completed" : outcome;
      outcomes.push({ actionClass: action.actionClass, outcome, detail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: detail }),
      );
    };

    // 1) Kill-switch (global or per-repo) halts everything.
    if (mode === "paused") {
      await audit("denied", "agent actions paused");
      continue;
    }
    // 2) Current per-action autonomy must still permit this action. Pending approvals are durable, so re-check
    //    the live repo policy before staging or executing a previously planned action.
    if (!isActingAutonomyLevel(autonomyLevel)) {
      await audit("denied", `autonomy for ${action.actionClass} is ${autonomyLevel} — action not currently enabled`);
      continue;
    }
    // 3) auto_with_approval stages the action in the approval queue (#779) for a one-tap maintainer decision
    //    instead of executing it now.
    if (action.requiresApproval) {
      await stageForApproval(env, ctx, action, autonomyLevel);
      await audit("queued", `awaiting maintainer approval — ${action.reason}`);
      continue;
    }
    // 4) Write-permission readiness: a PR-write action needs `pull_requests: write` granted.
    if (PR_WRITE_CLASSES.has(action.actionClass) && resolveAgentPermissionReadiness({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions }) !== "ready") {
      await audit("denied", "pull_requests: write not granted — maintainer must re-consent");
      continue;
    }
    // 5) dry-run records the intent without touching GitHub.
    if (mode === "dry_run") {
      await audit("dry_run", `dry-run: would ${action.actionClass} — ${action.reason}`);
      continue;
    }
    // 6) live — perform the real mutation, recording success or the error.
    try {
      await performAction(env, ctx, action);
      await audit("completed", action.reason);
      // Per-repo Discord notification on a terminal/visible action (reviewbot parity): merge→merged,
      // close→closed, request_changes→manual review. Best-effort; never affects the action. RC1 dedups at the
      // action level, so this fires once per outcome per PR (no spam).
      const notifyOutcome: NotifyOutcome | null =
        action.actionClass === "merge" ? "merged" : action.actionClass === "close" ? "closed" : action.actionClass === "request_changes" ? "manual" : null;
      if (notifyOutcome) {
        await notifyActionToDiscord(env, { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, outcome: notifyOutcome, summary: action.reason, submitter: ctx.authorLogin }).catch(() => undefined);
      }
    } catch (error) {
      await audit("error", errorMessage(error));
      // RC3 terminal-fail merges: a merge that fails on perms (403/405) / required-check-absent (409) / a real
      // conflict can NEVER complete for this commit — mark it terminally merge-blocked so the planner stops
      // re-planning it every sweep. A possibly-transient failure is retried up to MERGE_RETRY_CAP then held.
      if (action.actionClass === "merge" && ctx.headSha) {
        await handleMergeFailure(env, ctx, error);
      }
    }
  }

  return outcomes;
}

// RC3: persist the outcome of a FAILED merge so it is never retried blindly forever. A non-transient failure
// (403/405 perms, 409 required-check-absent, merge conflict) is terminal immediately; an otherwise-unclassified
// failure (e.g. base moved during the merge — a benign TOCTOU race) is retried up to MERGE_RETRY_CAP and then
// escalated to the same terminal hold. Either way the planner suppresses the merge for this head SHA and the PR
// is held for a human (never auto-closed).
async function handleMergeFailure(env: Env, ctx: AgentActionExecutionContext, error: unknown): Promise<void> {
  const headSha = ctx.headSha;
  /* v8 ignore next -- guarded at the call site; defensive. */
  if (!headSha) return;
  const message = errorMessage(error);
  const { terminal: classifiedTerminal, reason: classifiedReason } = classifyMergeFailure(error);
  let terminal = classifiedTerminal;
  let reason = classifiedReason;
  if (!terminal) {
    // Possibly transient: bound the retries so a persistently-failing "clean" merge still escalates.
    const attempts = await bumpPullRequestMergeAttempt(env, ctx.repoFullName, ctx.pullNumber, headSha);
    if (attempts >= MERGE_RETRY_CAP) {
      terminal = true;
      reason = `merge could not complete after ${attempts} attempt(s): ${message}`;
    }
  }
  if (!terminal) return;
  await markPullRequestMergeBlocked(env, ctx.repoFullName, ctx.pullNumber, headSha, reason);
  await recordAuditEvent(env, {
    eventType: "agent.action.merge_blocked",
    actor: AGENT_ACTOR,
    targetKey: `${ctx.repoFullName}#${ctx.pullNumber}`,
    outcome: "denied",
    detail: `merge held for human — ${reason}`,
    metadata: { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, headSha, reason: reason.slice(0, 280) },
  }).catch(() => undefined);
}

async function performAction(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction): Promise<void> {
  switch (action.actionClass) {
    case "label":
      await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "", { createMissingLabel: true });
      return;
    case "request_changes":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "REQUEST_CHANGES", action.reviewBody ?? "");
      return;
    case "approve":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "APPROVE", action.reviewBody ?? "");
      return;
    case "merge":
      await mergePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, { mergeMethod: action.mergeMethod ?? "squash", ...(ctx.headSha ? { sha: ctx.headSha } : {}) });
      return;
    case "close":
      if (action.closeComment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.closeComment);
      await closePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber);
      return;
  }
}

/** The execute-time payload of a planned action, persisted so the approval queue (#779) can run it on accept. */
export function actionParams(action: PlannedAgentAction): AgentPendingActionParams {
  return {
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.reviewBody !== undefined ? { reviewBody: action.reviewBody } : {}),
    ...(action.mergeMethod !== undefined ? { mergeMethod: action.mergeMethod } : {}),
    ...(action.closeComment !== undefined ? { closeComment: action.closeComment } : {}),
  };
}

/** Rebuild a PlannedAgentAction from a persisted approval-queue row so the executor can run it on accept. The
 *  rebuilt action is `requiresApproval: false` — the maintainer's accept IS the approval. */
export function pendingActionToPlanned(input: { actionClass: AgentActionClass; params: AgentPendingActionParams; reason?: string | null | undefined }): PlannedAgentAction {
  return { actionClass: input.actionClass, requiresApproval: false, reason: input.reason ?? "maintainer-approved", ...input.params };
}

// Persist the staged action + notify the maintainer ONCE (on first staging, not on every re-evaluation).
async function stageForApproval(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction, autonomyLevel: AutonomyLevel): Promise<void> {
  const { created } = await createPendingAgentActionIfAbsent(env, {
    repoFullName: ctx.repoFullName,
    pullNumber: ctx.pullNumber,
    installationId: ctx.installationId,
    actionClass: action.actionClass,
    autonomyLevel,
    params: actionParams(action),
    reason: action.reason,
  });
  if (!created) return;
  /* v8 ignore next -- a repo full name always has an owner segment; the empty fallback is purely defensive. */
  const recipientLogin = ctx.repoFullName.split("/")[0] ?? "";
  await insertNotificationDeliveryIfAbsent(env, {
    dedupKey: `agent.pending_action:${ctx.repoFullName}#${ctx.pullNumber}:${action.actionClass}`,
    channel: "badge",
    recipientLogin,
    eventType: "agent.pending_action",
    repoFullName: ctx.repoFullName,
    pullNumber: ctx.pullNumber,
    title: `Gittensory staged a ${action.actionClass.replace(/_/g, " ")} for your approval`,
    body: `${action.reason}. Accept to execute it, or reject to cancel.`,
    deeplink: `https://github.com/${ctx.repoFullName}/pull/${ctx.pullNumber}`,
    actorLogin: AGENT_ACTOR,
  });
}
