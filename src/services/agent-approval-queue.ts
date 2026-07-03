import { getInstallation, getPullRequest, getPendingAgentAction, recordAuditEvent, setPendingAgentActionStatus } from "../db/repositories";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { createInstallationToken } from "../github/app";
import { loadLinkedIssueHardRules, resolveLinkedIssueHardRule } from "../review/linked-issue-hard-rules";
import { executeAgentMaintenanceActions, pendingActionToPlanned } from "./agent-action-executor";
import { downgradeCloseToHold, downgradeMergeToHold, isProtectedAutomationAuthor, type PlannedAgentAction } from "../settings/agent-actions";
import { findBlacklistEntry } from "../settings/contributor-blacklist";
import { parseGitHubLoginList } from "../auth/security";
import { isCloseHoldOnly, isHoldOnly } from "../review/outcomes-wire";
import { fetchLiveCiAggregate, fetchLivePullRequestMergeState, fetchLivePullRequestReviewDecision } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import type { AgentPendingActionParams, AgentPendingActionRecord } from "../types";

export type ApprovalDecision = "accept" | "reject";

export type ApprovalDecisionResult = {
  status: "accepted" | "errored" | "rejected" | "already_decided" | "not_found";
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
    resolveRepositorySettings(env, pending.repoFullName),
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
  // An unpinned staged approve, merge, or close (no expectedHeadSha) cannot be safety-verified against a
  // force-push that happened during the queue wait. For a PINNED merge, GitHub's `sha` param 409s on mismatch --
  // a real backstop. But that backstop only exists because there's something to compare against; an UNPINNED
  // merge falls back to performAction's `mergeSha = action.expectedHeadSha ?? ctx.headSha`, which by construction
  // substitutes whatever head is live right now, so it trivially "matches" and no 409 is possible. The reviews
  // API's `commit_id` has no server-side staleness rejection at all, pinned or not (#2377). close has no
  // server-side commit target at all -- its OWN freshness relies entirely on this application-level pin, since
  // closePullRequest doesn't take a sha the way merge/reviews do. Either way, the check above only fires when a
  // pin EXISTS and disagrees with the live head; a row staged with no pin at all (e.g. by code predating this
  // head-pinning fix, or a planning pass that ran against a transiently-null stored head SHA) would otherwise
  // fall through to the executor's `ctx.headSha` fallback and silently ratify whatever commit is live NOW, under
  // the authority of a review/merge/close that was never actually performed against it (#2422, #2452).
  // dismissStaleApproval is exempt: it RETRACTS the bot's existing approval rather than granting a new one at a
  // specific commit, so it carries no "ratify unreviewed code" risk and is safe to replay unpinned.
  const isUnpinnedRatifyingAction =
    !stagedHead &&
    ((pending.actionClass === "approve" && !pending.params.dismissStaleApproval) || pending.actionClass === "merge" || pending.actionClass === "close");
  if (isUnpinnedRatifyingAction) {
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

  // Re-resolve blacklist membership live at accept time (#2452). The head-SHA pin above only catches a
  // FORCE-PUSH; it says nothing about whether the contributor is STILL blacklisted, and a blacklist close is a
  // sticky auto_with_approval row with no expiry -- a maintainer can remove the entry (or edit .gittensory.yml)
  // at any point while it sits waiting. `settings` was fetched fresh at the top of this function, so this
  // mirrors the exact same pure check the planner uses (processors.ts), just re-run against CURRENT effective config.
  if (pending.actionClass === "close" && pending.params.closeKind === "blacklist" && pr) {
    const stillBlacklisted = findBlacklistEntry(pr.authorLogin, settings.contributorBlacklist) !== null;
    if (!stillBlacklisted) {
      await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
      await recordAuditEvent(env, {
        eventType: "agent.pending_action.superseded",
        actor: input.decidedBy,
        targetKey,
        outcome: "denied",
        detail: "superseded blacklist close: contributor is no longer on the blacklist",
        metadata: baseMetadata,
      });
      return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy }, executionOutcome: "no_longer_blacklisted" };
    }
  }

  // Re-validate a staged CLOSE tagged "linked-issue-hard-rule" against the CURRENT hard-rule state (flagged by
  // the gate's own review of #2452, twice). Mirrors the blacklist re-check above: the head-SHA pin only catches
  // a force-push, not a maintainer relabeling/reassigning the linked issue (or editing hard-rule config) while
  // the close sits waiting in the queue -- head SHA unchanged, so the pin doesn't catch it. Unlike the merge
  // re-check below (which supersedes a merge when the rule BECOMES violated), this close was staged BECAUSE the
  // rule WAS violated, so this supersedes it when the rule is NO LONGER violated -- the close's own justification
  // evaporated. Also re-derives closeEligible (mirrors the merge re-check's own closeEligible below): the planner
  // confirmed eligibility at STAGING time, but settings.closeOwnerAuthors is a live toggle that can flip to false
  // between staging and accept without moving the head SHA, same staleness class as the rule check itself -- an
  // owner PR staged for close while the setting was true must not still close after it is turned off.
  if (pending.actionClass === "close" && pending.params.closeKind === "linked-issue-hard-rule" && pr) {
    const repoOwner = pending.repoFullName.includes("/") ? pending.repoFullName.slice(0, pending.repoFullName.indexOf("/")) : "";
    const authorLogin = pr.authorLogin ?? "";
    const authorIsOwner = authorLogin.length > 0 && authorLogin.toLowerCase() === repoOwner.toLowerCase();
    // Fleet-operator identity (#2133): an ADMIN_GITHUB_LOGINS login gets the same never-auto-closed exemption
    // as the owner, so it must be re-gated on closeOwnerAuthors here too — matching the live planner
    // (queue/processors.ts) and staging (settings/agent-actions.ts closeEligible). Without this, an admin PR
    // staged for close while the toggle was on would still close after the operator turns it off.
    const authorIsAdmin = authorLogin.length > 0 && parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(authorLogin.toLowerCase());
    const authorIsAutomationBot = isProtectedAutomationAuthor(pr.authorLogin);
    const closeEligible = (!authorIsOwner && !authorIsAdmin && !authorIsAutomationBot) || ((authorIsOwner || authorIsAdmin) && settings.closeOwnerAuthors === true);
    let stillJustified = closeEligible;
    if (closeEligible) {
      const linkedIssueRulesConfig = await loadLinkedIssueHardRules(env, pending.repoFullName);
      // Best-effort mint, same fail-open contract as the merge re-check below (#2126/#2132): a failed mint or a
      // resolution that can't gather issue facts falls back to resolveLinkedIssueHardRule's own "not violated"
      // default, which this check then treats as "the close is no longer justified" -- the SAFE direction for an
      // irreversible close (superseding it re-stages from a fresh sweep instead of risking a wrongful auto-close).
      const ciToken = await createInstallationToken(env, pending.installationId).catch(() => undefined);
      const linkedIssueHardRule = await resolveLinkedIssueHardRule({
        env,
        repoFullName: pending.repoFullName,
        repoOwner,
        config: linkedIssueRulesConfig,
        body: pr.body,
        linkedIssues: pr.linkedIssues,
        ciToken,
        installationId: pending.installationId,
      });
      stillJustified = linkedIssueHardRule?.violated === true;
    }
    if (!stillJustified) {
      await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
      await recordAuditEvent(env, {
        eventType: "agent.pending_action.superseded",
        actor: input.decidedBy,
        targetKey,
        outcome: "denied",
        detail: closeEligible
          ? "superseded linked-issue hard-rule close: the linked issue is no longer ineligible"
          : "superseded linked-issue hard-rule close: the author is no longer close-eligible (owner/automation exemption now applies)",
        metadata: baseMetadata,
      });
      return {
        status: "rejected",
        action: { ...pending, status: "rejected", decidedBy: input.decidedBy },
        executionOutcome: closeEligible ? "linked_issue_no_longer_violated" : "no_longer_close_eligible",
      };
    }
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

  // Re-validate a staged MERGE against the CURRENT linked-issue hard-rule state (#2132). The hard rule is
  // evaluated fresh on every planning pass and takes precedence over merge (see planAgentMaintenanceActions),
  // but a staged merge only replays the PLAN-TIME snapshot — a maintainer relabeling/reassigning the linked
  // issue between staging and accept (head SHA unchanged, so the check above doesn't catch it) would otherwise
  // still merge a now-ineligible PR. Mirrors the planner's own owner/automation exemption (closeEligible) so an
  // owner's staged merge, which the hard rule never blocks in the first place, is not wrongly denied here.
  // Gated on the POST-downgrade `plan`, not `pending.actionClass`: the precision-breaker downgrade immediately
  // above can already have replaced a staged merge with a needs-human-review label (downgradeMergeToHold) — that
  // downgraded plan isn't going to merge anything, so a stale linked-issue violation must not reject the whole
  // row and suppress the hold label; it only matters while a merge is still the thing about to execute.
  if (plan.some((action) => action.actionClass === "merge") && pr) {
    const repoOwner = pending.repoFullName.includes("/") ? pending.repoFullName.slice(0, pending.repoFullName.indexOf("/")) : "";
    const authorLogin = pr.authorLogin ?? "";
    const authorIsOwner = authorLogin.length > 0 && authorLogin.toLowerCase() === repoOwner.toLowerCase();
    // Fleet-operator identity (#2133): mirror the primary close-eligibility exemption for an admin login, so a
    // now-close-eligible admin PR supersedes its staged merge on the same terms an owner's does.
    const authorIsAdmin = authorLogin.length > 0 && parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(authorLogin.toLowerCase());
    const authorIsAutomationBot = isProtectedAutomationAuthor(pr.authorLogin);
    const closeEligible = (!authorIsOwner && !authorIsAdmin && !authorIsAutomationBot) || ((authorIsOwner || authorIsAdmin) && settings.closeOwnerAuthors === true);
    if (closeEligible) {
      const linkedIssueRulesConfig = await loadLinkedIssueHardRules(env, pending.repoFullName);
      // Best-effort mint, same as the #2126 CI/mergeable/review re-check above: a failed mint here does NOT
      // silently skip the recheck -- resolveLinkedIssueHardRule falls back to env.GITHUB_PUBLIC_TOKEN when
      // ciToken is undefined and still attempts the fetch, only returning "not violated" if that ALSO can't
      // gather issue facts. This is the same shared resolver + same fail-open contract the LIVE planning path
      // (processors.ts) already relies on for the PRIMARY hard-rule decision; holding this SECONDARY, narrow-
      // race-window recheck to a stricter fail-closed standard would deny otherwise-legitimate merges on every
      // transient token-mint hiccup without closing a real gap (the executor mints its OWN token independently
      // for the actual merge mutation, so a suspended/broken installation still fails there regardless).
      const ciToken = await createInstallationToken(env, pending.installationId).catch(() => undefined);
      const linkedIssueHardRule = await resolveLinkedIssueHardRule({
        env,
        repoFullName: pending.repoFullName,
        repoOwner,
        config: linkedIssueRulesConfig,
        body: pr.body,
        linkedIssues: pr.linkedIssues,
        ciToken,
        installationId: pending.installationId,
      });
      if (linkedIssueHardRule?.violated) {
        await setPendingAgentActionStatus(env, pending.id, { status: "rejected", decidedBy: input.decidedBy });
        await recordAuditEvent(env, {
          eventType: "agent.pending_action.superseded",
          actor: input.decidedBy,
          targetKey,
          outcome: "denied",
          detail: `superseded merge: linked-issue hard rule now violated — ${linkedIssueHardRule.reason ?? "ineligible linked issue"}`,
          metadata: { ...baseMetadata, linkedIssueReason: linkedIssueHardRule.reason },
        });
        return { status: "rejected", action: { ...pending, status: "rejected", decidedBy: input.decidedBy }, executionOutcome: "linked_issue_hard_rule" };
      }
    }
  }

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
      // CI-run cancellation on a contributor_cap close (#2462): a contributor_cap close CAN be staged for
      // approval (close autonomy = auto_with_approval), so the accept-replay path needs this resolved the
      // same way the live webhook path does (src/queue/processors.ts) for the cancel hook to fire here too.
      contributorCapCancelCi: settings.contributorCapCancelCi ?? env.CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT === "true",
    },
    plan,
  );
  /* v8 ignore next -- the executor returns one outcome per planned action, so the fallback is defensive. */
  const execOutcome = outcomes[0]?.outcome ?? "no_outcome";
  // "error" means performAction threw a real exception (a GitHub-call failure) -- persist "errored" so a
  // maintainer scanning the queue can see the mutation itself failed, not just that a decision was recorded.
  // Every OTHER outcome ("completed", "denied", "dry_run", "queued") is a clean result of the executor's own
  // gates running to a normal conclusion -- "denied" in particular is an intentional policy decision (autonomy no
  // longer authorizes, dry-run active, a live pre-condition failed cleanly), not a failure, so it correctly stays
  // "accepted": the maintainer's accept WAS honored, the executor just chose not to act on it (#2423).
  const finalStatus = execOutcome === "error" ? "errored" : "accepted";
  await setPendingAgentActionStatus(env, pending.id, { status: finalStatus, decidedBy: input.decidedBy });
  await recordAuditEvent(env, {
    eventType: "agent.pending_action.accepted",
    actor: input.decidedBy,
    targetKey,
    outcome: execOutcome === "completed" ? "completed" : "error",
    detail: `accepted ${pending.actionClass} → ${execOutcome}`,
    metadata: { ...baseMetadata, executionOutcome: execOutcome },
  });
  return { status: finalStatus, action: { ...pending, status: finalStatus, decidedBy: input.decidedBy }, executionOutcome: execOutcome };
}
