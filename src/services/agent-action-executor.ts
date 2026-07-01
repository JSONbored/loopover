import { bumpPullRequestMergeAttempt, createPendingAgentActionIfAbsent, insertNotificationDeliveryIfAbsent, isGlobalAgentFrozen, markPullRequestApproved, markPullRequestMergeBlocked, recordAuditEvent } from "../db/repositories";
import { classifyMergeFailure, MERGE_RETRY_CAP } from "./merge-failure";
import { notifyActionToDiscord, notifyActionToSlack, type NotifyOutcome } from "./notify-discord";
import { createInstallationToken } from "../github/app";
import { fetchLiveCiAggregate } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { ensurePullRequestLabel, removePullRequestLabel } from "../github/labels";
import { closePullRequest, createIssueComment, createPullRequestReview, dismissLatestBotApproval, mergePullRequest, updatePullRequestBranch } from "../github/pr-actions";
import { fetchPullRequestFreshness, pullRequestFreshnessDetail } from "../github/pr-freshness";
import { isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { buildAgentActionAudit, isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import type { PlannedAgentAction } from "../settings/agent-actions";
import type { AgentActionClass, AgentPendingActionParams, AutonomyLevel, AutonomyPolicy } from "../types";
import { errorMessage } from "../utils/json";
import { AGENT_LABEL_PENDING_CLOSURE } from "../review/linked-issue-hard-rules";

// The agent actor name on every audit record — the App acts on the maintainer's behalf per their configured
// autonomy (the config IS the authorization; there is no human commenter to authorize, unlike #824).
const AGENT_ACTOR = "gittensory";

// The PR-state action classes that require GitHub `pull_requests: write`. `label` mutates via the Issues API
// (`issues: write`, always held), so it is exempt from the write-permission readiness gate. Exported so the
// agent-execution test can enforce the invariant that every member is also counted by agentRequiresPrWrite
// (PR_WRITE_ACTION_CLASSES is a superset), so this runtime guard never disagrees with the readiness gate.
export const PR_WRITE_CLASSES = new Set<AgentActionClass>(["request_changes", "approve", "merge", "close", "update_branch"]);

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

// Pass-2 trigger predicate (flag-then-close double-check): true iff the executed plan included a pending-closure
// label-ADD whose mutation actually COMPLETED. A queued (approval-gated) / failed / dry-run / denied label does NOT
// establish the label-backed state the verification pass reads, so re-enqueuing the delayed re-review off the plan
// alone would create a verification loop. `outcomes[i]` is the outcome of `planned[i]` (1:1, same order).
export function pendingClosureLabelApplied(plan: PlannedAgentAction[], outcomes: AgentActionOutcome[]): boolean {
  return plan.some((action, index) => action.actionClass === "label" && action.label === AGENT_LABEL_PENDING_CLOSURE && action.labelOp === "add" && outcomes[index]?.outcome === "completed");
}

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
  // globalPaused folds the env-var brake AND the DB-backed kill-switch (#audit-§5.2) so an operator can halt the
  // fleet instantly via one DB row, without a redeploy.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

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
    // 3) dry-run records the intent without touching GitHub, so it does not need a live freshness read.
    if (mode === "dry_run") {
      await audit("dry_run", `dry-run: would ${action.actionClass} — ${action.reason}`);
      continue;
    }
    // 4) auto_with_approval stages the action in the approval queue (#779) for a one-tap maintainer decision
    //    instead of executing it now. Staging is not a GitHub mutation; execution/replay runs this guard later.
    if (action.requiresApproval) {
      await stageForApproval(env, ctx, action, autonomyLevel);
      await audit("queued", `awaiting maintainer approval — ${action.reason}`);
      continue;
    }
    // 5) Freshness guard: every supported live action mutates PR state or PR-visible output, so it must still
    //    target the reviewed, open head. This protects approval-queue replays and slow webhook jobs from
    //    force-pushes or manual closes that happen after the review was planned.
    const expectedHeadSha = action.expectedHeadSha ?? ctx.headSha ?? null;
    if (!expectedHeadSha) {
      await audit("denied", "live PR head guard unavailable — action not executed");
      continue;
    }
    const freshness = await fetchPullRequestFreshness(env, {
      installationId: ctx.installationId,
      repoFullName: ctx.repoFullName,
      pullNumber: ctx.pullNumber,
      expectedHeadSha,
    });
    if (freshness.status !== "current") {
      await audit("denied", `${pullRequestFreshnessDetail(freshness)} — action not executed`);
      continue;
    }
    // 6) Live CI re-verification for a merge or a heuristic close (#2128): the CI aggregate that drove either
    //    decision was read seconds-to-tens-of-seconds earlier, in the planning pass, and the freshness guard
    //    above only re-checks head SHA/state, not CI. GitHub's own merge endpoint enforces branch-protection
    //    REQUIRED checks server-side, but only as a backstop when a repo actually configures them; a heuristic
    //    close has no server-side check at all. Re-read live CI right before the mutation so a check that
    //    flipped in this narrow window is never acted on from stale information. Deterministic closes
    //    (linked-issue hard-rule, blacklist) are exempt — they are zero-hallucination facts that do not depend
    //    on CI, and the linked-issue rule already has its own flag-then-verify pass.
    if (action.actionClass === "merge" || (action.actionClass === "close" && action.closeKind === "heuristic")) {
      const ciToken = await createInstallationToken(env, ctx.installationId).catch(() => undefined);
      const admissionKey = githubRateLimitAdmissionKeyForToken(env, ciToken, ctx.installationId);
      const liveCi = await fetchLiveCiAggregate(env, ctx.repoFullName, expectedHeadSha, ciToken, undefined, admissionKey);
      // The planner itself only ever stages a merge when ciState === "passed" exactly (reviewGood in
      // agent-actions.ts; "pending" short-circuits to no actions at all upstream) -- the live re-check must
      // require the SAME exact state, not just "not failed". Otherwise a check that regressed to pending or
      // became unreadable (unverified) between planning and actuation would still merge, on the assumption
      // that only an explicit failure invalidates the plan.
      const staleReason =
        action.actionClass === "merge"
          ? liveCi.ciState !== "passed"
            ? `live CI is no longer passing (now: ${liveCi.ciState})`
            : null
          : liveCi.ciState !== "failed"
            ? `CI state changed since planning (now: ${liveCi.ciState})`
            : null;
      if (staleReason) {
        await audit("denied", `${staleReason} — action not executed`);
        continue;
      }
    }
    // 7) Write-permission readiness: a PR-write action needs `pull_requests: write` granted.
    if (PR_WRITE_CLASSES.has(action.actionClass) && resolveAgentPermissionReadiness({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions }) !== "ready") {
      await audit("denied", "pull_requests: write not granted — maintainer must re-consent");
      continue;
    }
    // 8) live — perform the real mutation, recording success or the error.
    try {
      await performAction(env, ctx, action);
      await audit("completed", action.reason);
      // Re-approval idempotency: record the head SHA we just approved so the planner skips re-approving this
      // exact commit on the next sweep (a GitHub App's own approval does not reliably flip reviewDecision to
      // APPROVED, so reviewDecision alone can't dedup). A new commit clears the match → the bot approves it.
      // Best-effort: a failed persist only risks one redundant re-approval, never a wrong disposition.
      if (action.actionClass === "approve" && !action.dismissStaleApproval && ctx.headSha) {
        await markPullRequestApproved(env, ctx.repoFullName, ctx.pullNumber, ctx.headSha).catch(() => undefined);
      }
      // Per-repo Discord notification on a terminal/visible action (reviewbot parity): merge→merged,
      // close→closed, request_changes→manual review. Best-effort; never affects the action. RC1 dedups at the
      // action level, so this fires once per outcome per PR (no spam).
      const notifyOutcome: NotifyOutcome | null =
        action.actionClass === "merge" ? "merged" : action.actionClass === "close" ? "closed" : action.actionClass === "request_changes" ? "manual" : null;
      if (notifyOutcome) {
        const notifyParams = { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, outcome: notifyOutcome, summary: action.reason, submitter: ctx.authorLogin };
        await notifyActionToDiscord(env, notifyParams).catch(() => undefined);
        await notifyActionToSlack(env, notifyParams).catch(() => undefined);
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
      // Flag-then-close double-check: a `label` action may ADD (default) or REMOVE its label, and may carry an
      // optional comment (the Pass-1 flag warning, or the resolved note) posted alongside the label mutation.
      if (action.labelOp === "remove") {
        await removePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "");
      } else {
        await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "", { createMissingLabel: true });
      }
      if (action.comment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.comment);
      return;
    case "request_changes":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "REQUEST_CHANGES", action.reviewBody ?? "");
      return;
    case "approve": {
      if (action.dismissStaleApproval) {
        await dismissLatestBotApproval(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "Gittensory retracted this approval — a newer commit no longer qualifies.");
        return;
      }
      // Pin the approve to the REVIEWED head (#2262), mirroring the merge case's identical pattern immediately
      // below: for an approval-queue replay this is the commit the maintainer reviewed, not necessarily the
      // current head, so GitHub's own commit_id targeting keeps a force-push after staging from silently
      // landing on the new, unreviewed commit. A live sweep plans expectedHeadSha == ctx.headSha, so its
      // behavior is unchanged; the fallback covers any unpinned plan.
      const approveSha = action.expectedHeadSha ?? ctx.headSha;
      /* v8 ignore next -- the step-5 freshness guard above already denies the action when
       * action.expectedHeadSha ?? ctx.headSha is falsy, so approveSha (the same expression) is always a
       * truthy string here; the ?? undefined only satisfies createPullRequestReview's string|undefined type. */
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "APPROVE", action.reviewBody ?? "", approveSha ?? undefined);
      return;
    }
    case "merge": {
      // Pin the merge to the REVIEWED head (action.expectedHeadSha) when present — for an approval-queue replay
      // this is the commit the maintainer reviewed, not necessarily the current head, so a force-push after
      // staging fails safe with a 409 (→ terminal hold) instead of merging un-reviewed code. A live sweep plans
      // expectedHeadSha == ctx.headSha, so its behavior is unchanged; the fallback covers any unpinned plan.
      const mergeSha = action.expectedHeadSha ?? ctx.headSha;
      await mergePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, { mergeMethod: action.mergeMethod ?? "squash", ...(mergeSha ? { sha: mergeSha } : {}) });
      return;
    }
    case "close":
      if (action.closeComment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.closeComment);
      await closePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber);
      return;
    case "update_branch":
      await updatePullRequestBranch(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.expectedHeadSha);
      return;
  }
}

/** The execute-time payload of a planned action, persisted so the approval queue (#779) can run it on accept. */
export function actionParams(action: PlannedAgentAction): AgentPendingActionParams {
  return {
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.labelOp !== undefined ? { labelOp: action.labelOp } : {}),
    ...(action.comment !== undefined ? { comment: action.comment } : {}),
    ...(action.reviewBody !== undefined ? { reviewBody: action.reviewBody } : {}),
    ...(action.mergeMethod !== undefined ? { mergeMethod: action.mergeMethod } : {}),
    ...(action.closeComment !== undefined ? { closeComment: action.closeComment } : {}),
    ...(action.expectedHeadSha !== undefined ? { expectedHeadSha: action.expectedHeadSha } : {}),
    ...(action.dismissStaleApproval !== undefined ? { dismissStaleApproval: action.dismissStaleApproval } : {}),
    // Round-trip closeKind so a staged close's kind survives to accept-time — without it, the close-precision
    // breaker's isHeuristicClose check (which matches on closeKind === "heuristic") could never fire for any
    // staged close, silently defeating the breaker for the entire approval-queue accept path (#2127), and the
    // actuation-time live-CI re-check above (#2364) — which only applies to a heuristic close — would be
    // silently skipped for a lost discriminator.
    ...(action.closeKind !== undefined ? { closeKind: action.closeKind } : {}),
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
