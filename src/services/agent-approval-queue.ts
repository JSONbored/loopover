import { getInstallation, getPullRequest, getRepositorySettings, getPendingAgentAction, recordAuditEvent, setPendingAgentActionStatus } from "../db/repositories";
import { executeAgentMaintenanceActions, pendingActionToPlanned } from "./agent-action-executor";
import { downgradeCloseToHold, downgradeMergeToHold, type PlannedAgentAction } from "../settings/agent-actions";
import { isCloseHoldOnly, isHoldOnly } from "../review/outcomes-wire";
import { createInstallationToken } from "../github/app";
import { fetchLiveCiAggregate, fetchLivePullRequestMergeState, fetchLivePullRequestReviewDecision } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import type { AgentPendingActionParams, AgentPendingActionRecord } from "../types";

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

  // Re-validate the staged action against the LIVE head before executing. A staged merge records the reviewed
  // head (expectedHeadSha); if the contributor force-pushed after staging, the live head has moved and replaying
  // the action would act on un-reviewed code. Refuse, supersede the sticky row, and record it. This is the
  // application-level fail-safe; the executor additionally pins the GitHub merge to the reviewed SHA as a backstop.
  const stagedHead = pending.params.expectedHeadSha;
  if (stagedHead && pr?.headSha && stagedHead !== pr.headSha) {
    await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
    await recordAuditEvent(env, {
      eventType: "agent.pending_action.superseded",
      actor: input.decidedBy,
      targetKey,
      outcome: "denied",
      detail: `superseded ${pending.actionClass}: staged head ${stagedHead.slice(0, 12)} no longer matches live head ${pr.headSha.slice(0, 12)} (force-push after staging)`,
      metadata: { ...baseMetadata, stagedHeadSha: stagedHead, liveHeadSha: pr.headSha },
    });
    return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy }, executionOutcome: "head_moved" };
  }
  // An unpinned staged approve (no expectedHeadSha) cannot be safety-verified against a force-push that
  // happened during the queue wait: unlike merge's `sha` param (which GitHub 409s on mismatch), the reviews API's
  // `commit_id` is purely advisory -- GitHub will happily post an APPROVE at any valid commit, current or not.
  // The check above only fires when a pin EXISTS and disagrees with the live head; a row staged with no pin at
  // all (e.g. by code predating this head-pinning fix, or a planning pass that ran against a transiently-null
  // stored head SHA) would otherwise fall through to the executor's `ctx.headSha` fallback and silently approve
  // whatever commit is live NOW, under the authority of a review that was never actually performed against it.
  // dismissStaleApproval is exempt: it RETRACTS the bot's existing approval rather than granting a new one at a
  // specific commit, so it carries no "ratify unreviewed code" risk and is safe to replay unpinned.
  if (!stagedHead && pending.actionClass === "approve" && !pending.params.dismissStaleApproval) {
    await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
    await recordAuditEvent(env, {
      eventType: "agent.pending_action.superseded",
      actor: input.decidedBy,
      targetKey,
      outcome: "denied",
      detail: `superseded ${pending.actionClass}: staged with no reviewed-head pin, so freshness cannot be verified — re-stage from a fresh sweep`,
      metadata: baseMetadata,
    });
    return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy }, executionOutcome: "unpinned_legacy_action" };
  }

  // Re-derive live justification for a staged MERGE at accept time. auto_with_approval rows have no expiry, so
  // CI can flip red, the base can go dirty, or a reviewer can request changes while the row just sits waiting for
  // a maintainer — none of which move the head SHA, so the check above alone would not catch it. Best-effort: a
  // failed live read fails OPEN on that specific check (the executor's own mutation call independently needs a
  // valid token/state and will fail cleanly if something is actually wrong). (#2126)
  let liveParams: AgentPendingActionParams = pending.params;
  if (pending.actionClass === "merge" && pr?.headSha) {
    const token = await createInstallationToken(env, pending.installationId).catch(() => undefined);
    const admissionKey = githubRateLimitAdmissionKeyForToken(env, token, pending.installationId);
    // Promise.allSettled, not Promise.all: each live re-check is independently best-effort (per the comment
    // above), so ONE transient rejection must fail open on that specific check, not throw the whole accept
    // out of decidePendingAgentAction. A settled-rejected check is treated the same as "nothing concerning
    // found" -- exactly what each function's own internal fail-safe catch already resolves to on success.
    const [ciResult, mergeableResult, reviewResult] = await Promise.allSettled([
      fetchLiveCiAggregate(env, pending.repoFullName, pr.headSha, token, undefined, admissionKey),
      fetchLivePullRequestMergeState(env, pending.repoFullName, pending.pullNumber, token, admissionKey),
      fetchLivePullRequestReviewDecision(env, pending.repoFullName, pending.pullNumber, token, admissionKey),
    ]);
    // A REJECTED promise stays undefined (fail-open — the read itself failed, not a genuine CI signal); a
    // FULFILLED promise reporting anything other than "passed" (failed, pending, or unverified) is a real,
    // non-stale-tolerant signal that the staged merge's justification no longer holds (#2126).
    const ciState = ciResult.status === "fulfilled" ? ciResult.value.ciState : undefined;
    const mergeableState = mergeableResult.status === "fulfilled" ? mergeableResult.value : undefined;
    const reviewDecision = reviewResult.status === "fulfilled" ? reviewResult.value : undefined;
    const staleReason =
      ciState !== undefined && ciState !== "passed"
        ? `live CI is no longer passing (now: ${ciState})`
        : mergeableState === "dirty"
          ? "the base branch now conflicts (mergeable_state: dirty)"
          : reviewDecision === "CHANGES_REQUESTED"
            ? "a reviewer has since requested changes"
            : null;
    if (staleReason) {
      await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
      await recordAuditEvent(env, {
        eventType: "agent.pending_action.superseded",
        actor: input.decidedBy,
        targetKey,
        outcome: "denied",
        detail: `superseded ${pending.actionClass}: ${staleReason} since staging`,
        metadata: { ...baseMetadata, ciState: ciState ?? null, mergeableState: mergeableState ?? null, reviewDecision: reviewDecision ?? null },
      });
      return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy }, executionOutcome: "stale_disposition" };
    }
    // Re-sync the merge method to the CURRENT repo config, not the staging-time snapshot — the head-SHA pin
    // above should stay frozen (that's the reviewed commit), but the merge method is a live preference with no
    // reason to be frozen. (#2131)
    /* v8 ignore next -- getRepositorySettings always resolves autoMaintain via its own default policy; this
     *  guard exists only because RepositorySettings' type allows autoMaintain to be undefined. */
    if (settings.autoMaintain?.mergeMethod) {
      liveParams = { ...pending.params, mergeMethod: settings.autoMaintain.mergeMethod };
    }
  }

  // Re-apply the SAME merge/close precision circuit-breakers the live webhook path applies before executing, so
  // a breaker engaged AFTER staging (an operator halting a runaway auto-merge, or the auto-tuner tripping on a
  // precision drop) still holds this sticky pending row instead of executing it unmodified. (#2127)
  const [holdOnly, closeHoldOnly] = await Promise.all([isHoldOnly(env, pending.repoFullName), isCloseHoldOnly(env, pending.repoFullName)]);
  let plan: PlannedAgentAction[] = [pendingActionToPlanned({ actionClass: pending.actionClass, params: liveParams, reason: pending.reason })];
  if (holdOnly) plan = downgradeMergeToHold(plan, true);
  if (closeHoldOnly) plan = downgradeCloseToHold(plan, true);

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
    plan,
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
