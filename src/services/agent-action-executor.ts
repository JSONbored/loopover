import {
  bumpPullRequestMergeAttempt,
  countModerationViolationsForActor,
  createPendingAgentActionIfAbsent,
  getGlobalContributorBlacklist,
  getGlobalModerationConfig,
  insertNotificationDeliveryIfAbsent,
  isGlobalAgentFrozen,
  markPullRequestApproved,
  markPullRequestMergeBlocked,
  recordAuditEvent,
  recordModerationViolation,
  upsertGlobalContributorBlacklist,
} from "../db/repositories";
import { isAuthorBlacklisted } from "../settings/contributor-blacklist";
import { classifyMergeFailure, MERGE_RETRY_CAP } from "./merge-failure";
import { notifyActionToDiscord, notifyActionToSlack, type NotifyOutcome } from "./notify-discord";
import { cancelInFlightWorkflowRunsForHeadSha, createInstallationToken, githubErrorStatus, isGitHubRateLimitedError } from "../github/app";
import { fetchLiveCiAggregate, mergeRequiredCiContexts, refreshInstallationHealthForInstallation } from "../github/backfill";
import { githubRateLimitAdmissionKeyForToken } from "../github/client";
import { ensurePullRequestLabel, removePullRequestLabel } from "../github/labels";
import { closeIssue, closePullRequest, createIssueComment, createPullRequestReview, dismissLatestBotApproval, mergePullRequest, updatePullRequestBranch } from "../github/pr-actions";
import { fetchPullRequestFreshness, pullRequestFreshnessDetail } from "../github/pr-freshness";
import { isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { buildAgentActionAudit, formatAgentPermissionDenial, isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness, type AgentActionMode } from "../settings/agent-execution";
import type { PlannedAgentAction } from "../settings/agent-actions";
import type { AgentActionClass, AgentPendingActionParams, AutonomyLevel, AutonomyPolicy } from "../types";
import { errorMessage } from "../utils/json";
import { AGENT_LABEL_PENDING_CLOSURE } from "../review/linked-issue-hard-rules";
import {
  MODERATION_VIOLATION_EVENT_TYPE,
  moderationTierForViolationCount,
  resolveEffectiveModerationRules,
  resolveModerationGateEnabled,
  type ModerationRuleType,
} from "../settings/moderation-rules";
import { incr } from "../selfhost/metrics";

// The agent actor name on every audit record — the App acts on the maintainer's behalf per their configured
// autonomy (the config IS the authorization; there is no human commenter to authorize, unlike #824).
const AGENT_ACTOR = "gittensory";

// Bound on audit_events.detail / the reason embedded in buildAgentActionAudit (#terminal-outcome-audit). A
// heuristic close/hold reason is built by joining every blocker's title (agent-actions.ts), so an unbounded PR
// with many blockers could otherwise write an arbitrarily large string; matches the existing 280-char bound
// already used for mergeBlockedReason (db/repositories.ts) and the merge_blocked audit metadata below.
const AUDIT_REASON_MAX_LENGTH = 280;

// The PR-visible action classes that require an elevated GitHub App write permission. Most use
// `pull_requests: write`; merge uses `contents: write`; `label` mutates through the Issues API, so it is exempt
// from this readiness gate.
export const PR_WRITE_CLASSES = new Set<AgentActionClass>(["request_changes", "approve", "merge", "close", "update_branch"]);

const INSTALLATION_HEALTH_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const installationHealthRefreshAttempts = new Map<number, number>();

function shouldRefreshInstallationHealthAfterPrWriteFailure(installationId: number, error: unknown, nowMs = Date.now()): boolean {
  if (githubErrorStatus(error) !== 403 || isGitHubRateLimitedError(error)) return false;
  if (!/resource not accessible by integration|not have permission/i.test(errorMessage(error))) return false;
  const lastAttemptMs = installationHealthRefreshAttempts.get(installationId);
  if (lastAttemptMs !== undefined && nowMs - lastAttemptMs < INSTALLATION_HEALTH_REFRESH_COOLDOWN_MS) return false;
  installationHealthRefreshAttempts.set(installationId, nowMs);
  return true;
}

/** Test-only: clear the module-level installation health refresh cooldown so each test starts fresh. */
export function clearInstallationHealthRefreshCooldownForTest(): void {
  installationHealthRefreshAttempts.clear();
}

// A known-denied PR-write action (missing pull_requests:write) must not re-run the freshness + live-CI GitHub
// calls and re-write an identical audit record on every sweep (#selfhost-runtime-drift) -- that burns queue/API
// cycles on an outcome that cannot change until the maintainer re-consents (which itself only refreshes on the
// INSTALLATION_HEALTH_REFRESH_COOLDOWN_MS cadence above, or the periodic refresh-installation-health job). A
// bounded per-installation/repo/PR/action-class cooldown suppresses the redundant audit write/log while still
// counting every suppressed attempt, so the denial remains visible in metrics without flooding the audit table.
// The key is scoped to the PR too -- the permission denial is installation-wide, but a denial already audited
// for one PR must never silently suppress the FIRST denial audit for a different PR in the same repo/window,
// or that PR's maintainer never sees why it was denied.
const PR_WRITE_DENIAL_COOLDOWN_MS = 15 * 60 * 1000;
const writePermissionDenialCooldown = new Map<string, number>();

function writePermissionDenialKey(installationId: number, repoFullName: string, pullNumber: number, actionClass: AgentActionClass): string {
  return `${installationId}:${repoFullName}:${pullNumber}:${actionClass}`;
}

/** True when this exact installation/repo/action-class was already denied for a missing write permission within
 *  the cooldown window -- the caller should suppress the redundant audit + log, count it, and move on. A pure
 *  read: the caller must call markWritePermissionDenialAudited AFTER the loud audit write actually succeeds, not
 *  here -- arming the cooldown before that write lands would mean a transient audit DB failure on the first
 *  denial permanently swallows it (the retry within the window would see the cooldown already armed and never
 *  attempt the audit again). */
function shouldSuppressWritePermissionDenial(key: string, nowMs: number): boolean {
  const lastDeniedMs = writePermissionDenialCooldown.get(key);
  return lastDeniedMs !== undefined && nowMs - lastDeniedMs < PR_WRITE_DENIAL_COOLDOWN_MS;
}

/** Arms (or refreshes) the write-permission-denial cooldown -- call ONLY after the loud audit write for this
 *  exact denial has actually succeeded, so a failed audit write is retried on the very next pass instead of
 *  being silently suppressed for the whole cooldown window. */
function markWritePermissionDenialAudited(key: string, nowMs: number): void {
  writePermissionDenialCooldown.set(key, nowMs);
}

/** Test-only: clear the module-level write-permission denial cooldown so each test starts fresh. */
export function clearWritePermissionDenialCooldownForTest(): void {
  writePermissionDenialCooldown.clear();
}

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
  // CI-run cancellation on a contributor_cap close (#2462, anti-abuse): the CALLER resolves this (repo setting
  // ?? the CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var) before building the context — the executor itself has no
  // settings access, only whatever ctx carries, mirroring how agentPaused/agentDryRun are already threaded in.
  contributorCapCancelCi?: boolean | undefined;
  // Moderation-rules engine (#selfhost-mod-engine): the repo's PER-REPO override fields, resolved by the
  // CALLER from RepositorySettings before building the context (same "the executor has no settings access"
  // shape as contributorCapCancelCi above). Absent/undefined ⇒ inherit the global config's own defaults. The
  // GLOBAL config itself (whole-layer enabled, threshold, decay, auto-blacklist) is read directly by the
  // executor via getGlobalModerationConfig -- a single extra DB read only on the rare path where a
  // moderation-tracked close actually completed, not threaded through every caller.
  moderationSettings?: ModerationContextSettings | undefined;
  // settings.expectedCiContexts (#selfhost-ci-verification), resolved by the CALLER (same "the executor has no
  // settings access" shape as the fields above): the final pre-mutation live-CI re-verification (step 8 below)
  // must honor the SAME configured-required-contexts view the planning pass already evaluated against, or a
  // maintainer-configured expectedCiContexts repo could see the plan and its own execution-time re-check
  // disagree on ciState (e.g. a still-in-progress NON-required check reading "pending" here when the plan's
  // required-only view was already clean). Absent/undefined ⇒ fold-all mode, unchanged from before this field
  // existed.
  expectedCiContexts?: ReadonlyArray<string> | null | undefined;
};

export type ModerationContextSettings = {
  moderationGateMode?: "inherit" | "off" | "enabled" | undefined;
  moderationRules?: ModerationRuleType[] | undefined;
  moderationWarningLabel?: string | undefined;
  moderationBannedLabel?: string | undefined;
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

// #label-close-split-brain: the outcome of the `close` action tagged with `closeKind`, among the actions ALREADY
// processed in this batch (outcomes[i] is 1:1 with planned[i], same order — see pendingClosureLabelApplied above).
// The planner emits a coupled anti-abuse label+close pair (blacklist/contributor_cap/review_nag) with close pushed
// FIRST, so by the time the executor reaches the label, the close's real outcome is already recorded here.
// Undefined when no such close exists in this batch (e.g. a plain review_state_label with no closeKind at all).
function coupledCloseOutcome(planned: PlannedAgentAction[], outcomes: AgentActionOutcome[], closeKind: PlannedAgentAction["closeKind"]): AgentActionOutcome["outcome"] | undefined {
  for (let i = 0; i < outcomes.length; i++) {
    if (planned[i]?.actionClass === "close" && planned[i]?.closeKind === closeKind) return outcomes[i]?.outcome;
  }
  return undefined;
}

/**
 * Execute (or dry-run, or stage for approval) a planned auto-maintain action set on one PR. Each action runs
 * through the SAME deny-toward-safety gate stack:
 *   pause (#776 kill-switch) → current autonomy → dry_run → approval (auto_with_approval → #779 queue) →
 *   write-permission (#775, checked BEFORE any GitHub call so a known-denied write never spends freshness/live-CI
 *   API budget) → label/close correlation → freshness → live-CI re-verification → the real mutation.
 * Only `live` mode performs a real mutation; `dry_run` records what it WOULD do. Every path writes one
 * `agent.action.<class>` audit record (#776) EXCEPT a write-permission denial repeated within
 * PR_WRITE_DENIAL_COOLDOWN_MS of the last one for the same installation/repo/action-class, which is counted but
 * not re-audited (#selfhost-runtime-drift). A failed mutation is recorded as `error`, never swallowed.
 */
export async function executeAgentMaintenanceActions(env: Env, ctx: AgentActionExecutionContext, planned: PlannedAgentAction[]): Promise<AgentActionOutcome[]> {
  const outcomes: AgentActionOutcome[] = [];
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  // globalPaused folds the env-var brake AND the DB-backed kill-switch (#audit-§5.2) so an operator can halt the
  // fleet instantly via one DB row, without a redeploy.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

  for (const action of planned) {
    // #label-scoping: a `label` action may be authorized by a class OTHER than `label` itself (an anti-abuse
    // enforcement label rides on `close`; a disposition-communication label rides on `review_state_label`) —
    // this durable re-check must resolve autonomy via the SAME class the planner actually used, not the
    // literal GitHub-mutation kind, or a `label` action authorized via `close`/`review_state_label` would be
    // wrongly re-denied against the (likely still-`observe`) generic `label` dial. Absent for every action
    // whose `actionClass` already IS its own governing class (merge/close/approve/etc).
    const autonomyLevel = resolveAutonomy(ctx.autonomy, action.autonomyClass ?? action.actionClass);
    const audit = (outcome: AgentActionOutcome["outcome"], detail: string) => {
      const auditOutcome = outcome === "dry_run" ? "completed" : outcome;
      // Bounded like every other audit-facing reason field in this codebase (agent-action-executor.ts's own
      // merge_blocked path below, db/repositories.ts's mergeBlockedReason) -- a heuristic close's reason is
      // built by joining every blocker title, so a PR with many blockers could otherwise write an arbitrarily
      // large, un-truncated string into audit_events.detail (#terminal-outcome-audit).
      const boundedDetail = detail.length > AUDIT_REASON_MAX_LENGTH ? `${detail.slice(0, AUDIT_REASON_MAX_LENGTH)}…` : detail;
      outcomes.push({ actionClass: action.actionClass, outcome, detail: boundedDetail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: boundedDetail }),
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
    // 5) Write-permission readiness: a PR-visible action needs its exact GitHub App write permission granted.
    //    Merge is Contents: write, while review/close/update_branch are Pull requests: write. Checked here
    //    before the freshness/live-CI GitHub calls below so a known-denied action never spends that API budget on
    //    an outcome that cannot change until the maintainer re-consents (#selfhost-runtime-drift).
    if (PR_WRITE_CLASSES.has(action.actionClass) && resolveAgentPermissionReadiness({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions, actionClass: action.actionClass }) !== "ready") {
      incr("gittensory_agent_action_permission_denied_total", { actionClass: action.actionClass });
      const cooldownKey = writePermissionDenialKey(ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.actionClass);
      if (shouldSuppressWritePermissionDenial(cooldownKey, Date.now())) {
        // Already denied + audited for this exact installation/repo/action-class within the cooldown window --
        // count it (the denial stays visible in metrics) without re-writing an identical audit record every pass.
        incr("gittensory_agent_action_permission_denied_suppressed_total", { actionClass: action.actionClass });
        outcomes.push({
          actionClass: action.actionClass,
          outcome: "denied",
          detail: formatAgentPermissionDenial({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions, actionClass: action.actionClass, suppressed: true }),
        });
        continue;
      }
      await audit("denied", formatAgentPermissionDenial({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions, actionClass: action.actionClass }));
      markWritePermissionDenialAudited(cooldownKey, Date.now());
      continue;
    }
    // 6) #label-close-split-brain: a `label` coupled to a same-batch anti-abuse close (closeKind set) must not
    //    post if that close already denied/errored THIS pass — `label` is exempt from the write-permission gate
    //    above that `close` is not, so without this correlation a transient `pull_requests: write` denial could
    //    leave a PR mislabeled "closed for X" while still open. A coupled close that is still "queued" (awaiting
    //    the SAME approval) or "completed" lets the label through unchanged; a close with no `closeKind` match
    //    (e.g. a plain review_state_label) is unaffected.
    if (action.actionClass === "label" && action.closeKind) {
      const closeOutcome = coupledCloseOutcome(planned, outcomes, action.closeKind);
      if (closeOutcome === "denied" || closeOutcome === "error") {
        await audit("denied", `paired ${action.closeKind} close did not complete (${closeOutcome}) — skipping the companion label so the PR isn't mislabeled while still open`);
        continue;
      }
    }
    // 7) Freshness guard: every supported live action mutates PR state or PR-visible output, so it must still
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
    // 8) Live CI re-verification for a merge or a CI-driven heuristic close (#2128): the CI aggregate that drove
    //    either decision was read seconds-to-tens-of-seconds earlier, in the planning pass, and the freshness
    //    guard above only re-checks head SHA/state, not CI. GitHub's own merge endpoint enforces
    //    branch-protection REQUIRED checks server-side, but only as a backstop when a repo actually configures
    //    them; a red-CI close has no server-side check at all. Re-read live CI right before the mutation so a
    //    check that flipped in this narrow window is never acted on from stale information. Non-CI closes
    //    (gate verdict, duplicate/slop, conflict, linked-issue hard-rule, blacklist) are exempt — their adverse
    //    signal does not depend on CI still being red.
    //    A heuristic close staged BEFORE #2478 has no closeRequiresCiState at all -- that field didn't exist yet
    //    -- so `undefined` here is genuinely ambiguous (a legacy CI-driven close and a legacy non-CI close are
    //    byte-identical in storage). The planner now ALWAYS sets the field going forward (never omits it), so
    //    `undefined` can only mean a legacy row; treat it with the old, broader pre-#2478 guard (require CI still
    //    failed) rather than skipping the recheck, which would let a stale CI-driven close silently execute
    //    after CI recovers (flagged by the gate's own review of #2478).
    const isAmbiguousLegacyHeuristicClose = action.actionClass === "close" && action.closeKind === "heuristic" && action.closeRequiresCiState === undefined;
    if (action.actionClass === "merge" || (action.actionClass === "close" && action.closeRequiresCiState === "failed") || isAmbiguousLegacyHeuristicClose) {
      const ciToken = await createInstallationToken(env, ctx.installationId).catch(() => undefined);
      const admissionKey = githubRateLimitAdmissionKeyForToken(env, ciToken, ctx.installationId);
      // mergeRequiredCiContexts(null, ...) -- no live branch-protection re-fetch here, just the maintainer's own
      // configured expectedCiContexts (or null/fold-all when unset), matching the "no branch protection" arm of
      // the planning pass's own merge (mergeRequiredCiContexts is pure and already exported for that call site).
      const liveCi = await fetchLiveCiAggregate(env, ctx.repoFullName, expectedHeadSha, ciToken, mergeRequiredCiContexts(null, ctx.expectedCiContexts), admissionKey);
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
          // isAmbiguousLegacyHeuristicClose falls back to "failed" (the old unconditional requirement); an
          // explicitly-tagged fresh close compares against its own recorded requirement.
          : liveCi.ciState !== (action.closeRequiresCiState ?? "failed")
            ? `CI state changed since planning (now: ${liveCi.ciState})`
            : null;
      if (staleReason) {
        await audit("denied", `${staleReason} — action not executed`);
        continue;
      }
    }
    // 9) live — perform the real mutation, recording success or the error.
    try {
      await performAction(env, ctx, action);
      await audit("completed", action.reason);
      // CI-run cancellation on a contributor_cap close (#2462, anti-abuse): stop burning CI minutes on a PR
      // that was just closed for exceeding the contributor cap. Best-effort, AFTER the close already
      // succeeded -- cancelInFlightWorkflowRunsForHeadSha never throws, so a missing actions:write grant (or
      // any other failure here) can never retroactively turn this already-successful close into a recorded
      // "error" by escaping into the catch block below.
      if (action.actionClass === "close" && action.closeKind === "contributor_cap" && ctx.contributorCapCancelCi && ctx.headSha) {
        await recordContributorCapCiCancelOutcome(env, ctx, ctx.headSha);
      }
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
      // RC3 terminal-fail merges: immediate terminal failures (401/405/409/conflict) are marked once; generic
      // GitHub 403s are retryable first because branch-protection/check/conversation state can converge shortly
      // after the gate publishes. A possibly-transient failure is retried up to MERGE_RETRY_CAP, then held.
      if (action.actionClass === "merge" && ctx.headSha) {
        await handleMergeFailure(env, ctx, error);
      }
      // #2265: a permission-looking 403 on a PR-write mutation can mean the LOCAL installations.permissions
      // snapshot is stale after a maintainer-initiated downgrade (GitHub sends no downgrade webhook). Rate-limit
      // 403s and operation-specific forbidden states are not permission evidence, and this refresh scans broad
      // installation state, so keep the hot error path narrowly filtered and per-installation cooled down.
      if (PR_WRITE_CLASSES.has(action.actionClass) && shouldRefreshInstallationHealthAfterPrWriteFailure(ctx.installationId, error)) {
        await refreshInstallationHealthForInstallation(env, ctx.installationId).catch(() => undefined);
      }
    }
  }

  await maybeEscalateModeration(env, { installationId: ctx.installationId, repoFullName: ctx.repoFullName, number: ctx.pullNumber, authorLogin: ctx.authorLogin, mode, moderationSettings: ctx.moderationSettings }, planned, outcomes);
  return outcomes;
}

const MODERATION_RULE_TYPES = new Set<string>(Object.keys(MODERATION_VIOLATION_EVENT_TYPE));

/**
 * Moderation-rules engine (#selfhost-mod-engine): a SINGLE convergence point for all three anti-abuse
 * mechanisms (blacklist, contributor cap, review-nag) that already tag their `close` action with a matching
 * `closeKind` -- rather than duplicating this wiring at every one of their several call sites in
 * `queue/processors.ts`, this scans the JUST-EXECUTED plan for a moderation-tracked close that actually
 * COMPLETED (not denied/queued/dry-run -- an action that didn't really happen must not count as a violation)
 * and, if so, records one violation + escalates. Never throws: every write here is best-effort, matching how
 * the rest of this file treats CI-cancellation/notification side effects as non-critical to the close itself.
 * A no-op in `dry_run`/`paused` mode (no label/ban side effects for a mutation that didn't really happen).
 */
async function maybeEscalateModeration(
  env: Env,
  args: { installationId: number; repoFullName: string; number: number; authorLogin?: string | null | undefined; mode: AgentActionMode; moderationSettings: ModerationContextSettings | undefined },
  planned: PlannedAgentAction[],
  outcomes: AgentActionOutcome[],
): Promise<void> {
  if (!args.authorLogin || args.mode !== "live") return;
  const index = planned.findIndex((action, i) => action.actionClass === "close" && action.closeKind !== undefined && MODERATION_RULE_TYPES.has(action.closeKind) && outcomes[i]?.outcome === "completed");
  const closeKind = index === -1 ? undefined : planned[index]?.closeKind;
  if (closeKind === undefined) return;
  const rule = closeKind as ModerationRuleType;

  const globalConfig = await getGlobalModerationConfig(env);
  if (!resolveModerationGateEnabled(globalConfig.enabled, args.moderationSettings?.moderationGateMode ?? "inherit")) return;
  const effectiveRules = resolveEffectiveModerationRules(globalConfig.rules, args.moderationSettings?.moderationRules);
  if (!effectiveRules.includes(rule)) return;

  const targetKey = `${args.repoFullName}#${args.number}`;
  // #gate-flagged: idempotent per (actor, eventType, targetKey) -- a webhook redelivery or queue retry that
  // re-executes an ALREADY-recorded close is not a new violation, so skip the rest of escalation entirely
  // (re-labeling/re-checking the ban threshold off a stale "nothing new happened" pass is redundant, not just
  // harmless). A write failure fails OPEN (treated as "new"), matching this function's existing best-effort
  // philosophy elsewhere -- a lost write should not also silently suppress the escalation it was recording for.
  const isNewViolation = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE[rule], actor: args.authorLogin, targetKey, repoFullName: args.repoFullName, ruleReason: `${rule} violation` }).catch(() => true);
  if (!isNewViolation) return;

  // #gate-flagged: count only the CURRENTLY-effective rule types, not every rule type ever recorded. A rule
  // an operator has excluded (globally or for this repo) must not go on influencing the ban decision just
  // because a violation of that kind happened to get recorded before the exclusion, or on a repo that still
  // counts it -- "we don't count reviewNag violations" is an ongoing policy stance about what this contributor's
  // standing should be judged on, not a per-recording footnote that only applies to where it happened.
  const countedEventTypes = effectiveRules.map((r) => MODERATION_VIOLATION_EVENT_TYPE[r]);
  const sinceIso = globalConfig.violationDecayDays !== null ? new Date(Date.now() - globalConfig.violationDecayDays * 24 * 60 * 60 * 1000).toISOString() : undefined;
  const totalCount = await countModerationViolationsForActor(env, args.authorLogin, countedEventTypes, sinceIso);
  const tier = moderationTierForViolationCount(totalCount, globalConfig.banThreshold);
  /* v8 ignore next -- defensive: the violation just recorded above always makes totalCount >= 1 by the time
     execution reaches here (the only way to see "none" is the record write itself silently failing, which
     moderationTierForViolationCount's own unit tests already cover directly for count=0). */
  if (tier === "none") return;

  const label = tier === "banned" ? (args.moderationSettings?.moderationBannedLabel ?? globalConfig.bannedLabel) : (args.moderationSettings?.moderationWarningLabel ?? globalConfig.warningLabel);
  await ensurePullRequestLabel(env, args.installationId, args.repoFullName, args.number, label, { createMissingLabel: true }).catch(() => undefined);

  if (tier === "banned" && globalConfig.autoBlacklistOnBan) {
    /* v8 ignore next -- getGlobalContributorBlacklist never actually resolves undefined (it fails open to
       `[]`); the `?? []` only satisfies RepositorySettings["contributorBlacklist"]'s optional TS type. */
    const current = (await getGlobalContributorBlacklist(env)) ?? [];
    if (!isAuthorBlacklisted(args.authorLogin, current)) {
      const banReason = `moderation-engine auto-ban: ${totalCount} lifetime violations reached the configured threshold`;
      const nextBlacklist = [...current, { login: args.authorLogin, reason: banReason, evidence: [targetKey] }];
      await upsertGlobalContributorBlacklist(env, { contributorBlacklist: nextBlacklist }).catch(() => undefined);
    }
  }
}

/** CI-run cancellation on a contributor_cap close (#2462): runs cancelInFlightWorkflowRunsForHeadSha and
 *  records exactly one of two audit outcomes, mirroring the established `github_app.*_permission_missing`
 *  convention (processors.ts's check-run/gate-check permission-missing audits) so a fleet-wide actions:write
 *  scope gap surfaces the same way those already do. Never throws -- both recordAuditEvent calls are
 *  best-effort (`.catch(() => undefined)`), since a failure to WRITE the audit record must not retroactively
 *  affect the close this already ran after. */
async function auditContributorCapCiCancelled(
  env: Env,
  targetKey: string,
  repoFullName: string,
  headSha: string,
  outcome: { cancelledCount: number; totalFound: number },
): Promise<void> {
  const detail = `cancelled ${outcome.cancelledCount} of ${outcome.totalFound} in-flight workflow run(s)`;
  const metadata = { repoFullName, headSha, cancelledCount: outcome.cancelledCount, totalFound: outcome.totalFound };
  const write = recordAuditEvent(env, { eventType: "github_app.contributor_cap_ci_cancelled", actor: AGENT_ACTOR, targetKey, outcome: "completed", detail, metadata });
  await write.catch(() => undefined);
}

// #gate finding: a genuine cancel error (network/create-token/list-run failure -- reason "error") is not a
// permission gap; recording it under the permission-missing event type mislabels it for anyone
// querying/dashboarding by eventType, even though metadata.reason already carries the real outcome.kind.
async function auditContributorCapCiCancelFailed(env: Env, targetKey: string, repoFullName: string, headSha: string, reason: string, warning: string): Promise<void> {
  const metadata = { repoFullName, headSha, reason };
  const eventType = reason === "permission_missing" ? "github_app.contributor_cap_ci_cancel_permission_missing" : "github_app.contributor_cap_ci_cancel_failed";
  const write = recordAuditEvent(env, { eventType, actor: AGENT_ACTOR, targetKey, outcome: "error", detail: warning, metadata });
  await write.catch(() => undefined);
}

async function recordContributorCapCiCancelOutcome(env: Env, ctx: AgentActionExecutionContext, headSha: string): Promise<void> {
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  const outcome = await cancelInFlightWorkflowRunsForHeadSha(env, ctx.installationId, ctx.repoFullName, headSha, ctx.pullNumber);
  if (outcome.kind === "cancelled") {
    await auditContributorCapCiCancelled(env, targetKey, ctx.repoFullName, headSha, outcome);
    return;
  }
  console.error(
    JSON.stringify({
      level: "error",
      event: "contributor_cap_ci_cancel_failed",
      reason: outcome.kind,
      repository: ctx.repoFullName,
      pullNumber: ctx.pullNumber,
      message: outcome.warning,
    }),
  );
  await auditContributorCapCiCancelFailed(env, targetKey, ctx.repoFullName, headSha, outcome.kind, outcome.warning);
}

export type IssueActionExecutionContext = {
  installationId: number;
  repoFullName: string;
  issueNumber: number;
  autonomy: AutonomyPolicy | null | undefined;
  agentPaused?: boolean | undefined;
  agentDryRun?: boolean | undefined;
  // Issue author login -- needed for the moderation-rules engine's violation ledger (#selfhost-mod-engine).
  authorLogin?: string | null | undefined;
  moderationSettings?: ModerationContextSettings | undefined;
};

/**
 * Execute (or dry-run) a planned label/close action set on an ISSUE — #2270's first issue-side actuation
 * (`planAgentMaintenanceActions`'s `contributor_cap` short-circuit is currently the only source of an
 * issue-targeted plan). Deliberately NARROWER than {@link executeAgentMaintenanceActions}:
 *   - Only `label` (add) and `close` are handled — the only classes the contributor_cap short-circuit ever
 *     produces. Any other class is denied defensively rather than mis-executed against an issue.
 *   - No freshness/live-CI-re-verification/pull_requests:write gate: none of those PR concepts apply to a
 *     plain issue (no head SHA, no CI, and a close needs `issues: write`, a different permission than the PR
 *     executor's write-readiness check covers).
 *   - `requiresApproval` (`auto_with_approval`) is DENIED, not staged: the pending-action queue is PR-shaped
 *     (pullNumber-typed staging + a `/pull/{n}` notification deeplink); extending it to issues is out of scope
 *     here. Denying — rather than silently executing or silently skipping the approval gate — keeps the
 *     configured autonomy honest: an operator who set `auto_with_approval` never gets an un-approved action.
 */
export async function executeIssueMaintenanceActions(env: Env, ctx: IssueActionExecutionContext, planned: PlannedAgentAction[]): Promise<AgentActionOutcome[]> {
  const outcomes: AgentActionOutcome[] = [];
  const targetKey = `${ctx.repoFullName}#${ctx.issueNumber}`;
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

  for (const action of planned) {
    // #label-scoping: a `label` action may be authorized by a class OTHER than `label` itself (an anti-abuse
    // enforcement label rides on `close`; a disposition-communication label rides on `review_state_label`) —
    // this durable re-check must resolve autonomy via the SAME class the planner actually used, not the
    // literal GitHub-mutation kind, or a `label` action authorized via `close`/`review_state_label` would be
    // wrongly re-denied against the (likely still-`observe`) generic `label` dial. Absent for every action
    // whose `actionClass` already IS its own governing class (merge/close/approve/etc).
    const autonomyLevel = resolveAutonomy(ctx.autonomy, action.autonomyClass ?? action.actionClass);
    const audit = (outcome: AgentActionOutcome["outcome"], detail: string) => {
      const auditOutcome = outcome === "dry_run" ? "completed" : outcome;
      // Bounded like every other audit-facing reason field in this codebase (agent-action-executor.ts's own
      // merge_blocked path below, db/repositories.ts's mergeBlockedReason) -- a heuristic close's reason is
      // built by joining every blocker title, so a PR with many blockers could otherwise write an arbitrarily
      // large, un-truncated string into audit_events.detail (#terminal-outcome-audit).
      const boundedDetail = detail.length > AUDIT_REASON_MAX_LENGTH ? `${detail.slice(0, AUDIT_REASON_MAX_LENGTH)}…` : detail;
      outcomes.push({ actionClass: action.actionClass, outcome, detail: boundedDetail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: boundedDetail }),
      );
    };

    if (mode === "paused") {
      await audit("denied", "agent actions paused");
      continue;
    }
    if (!isActingAutonomyLevel(autonomyLevel)) {
      await audit("denied", `autonomy for ${action.actionClass} is ${autonomyLevel} — action not currently enabled`);
      continue;
    }
    if (mode === "dry_run") {
      await audit("dry_run", `dry-run: would ${action.actionClass} — ${action.reason}`);
      continue;
    }
    if (action.requiresApproval) {
      await audit("denied", `awaiting maintainer approval — issue-side staging is not yet supported (${action.reason})`);
      continue;
    }
    if (action.actionClass !== "label" && action.actionClass !== "close") {
      /* v8 ignore next -- defensive: planAgentMaintenanceActions's contributor_cap short-circuit (this
       * executor's only caller today) never produces any class besides label/close. */
      await audit("denied", `unsupported action class for an issue: ${action.actionClass}`);
      continue;
    }
    try {
      if (action.actionClass === "label") {
        await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.issueNumber, action.label ?? "", { createMissingLabel: true });
      } else {
        if (action.closeComment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.issueNumber, action.closeComment);
        await closeIssue(env, ctx.installationId, ctx.repoFullName, ctx.issueNumber);
      }
      await audit("completed", action.reason);
    } catch (error) {
      await audit("error", errorMessage(error));
    }
  }

  await maybeEscalateModeration(env, { installationId: ctx.installationId, repoFullName: ctx.repoFullName, number: ctx.issueNumber, authorLogin: ctx.authorLogin, mode, moderationSettings: ctx.moderationSettings }, planned, outcomes);
  return outcomes;
}

// RC3: persist only TERMINAL failed-merge outcomes. Auth/policy/conflict failures are terminal immediately; a
// generic GitHub 403 is not, because it also covers branch-protection/check/conversation convergence after the
// bot publishes its own review/check. Retry those up to MERGE_RETRY_CAP before holding the PR for a human.
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
    case "update_branch": {
      // update_branch does NOT need the accept-flow-level "unpinned → deny" gate that #2377/#2422 added for
      // approve/merge: it only merges the current BASE into the head (never contributor-controlled content), so
      // it cannot itself ratify unreviewed code the way an approval or a merge does -- the worst case is a
      // premature rebase that fires a fresh synchronize and gets re-reviewed on the next pass (#2424). It's also
      // already covered by the generic guards that run before ANY action class reaches this switch: step 5's
      // freshness check (`expectedHeadSha ?? ctx.headSha`) denies on a moved head, and the approval-queue
      // accept-flow's supersede check (agent-approval-queue.ts) is actionClass-agnostic. The `?? ctx.headSha`
      // fallback below is pure parity/defense-in-depth for the tiny window between that freshness read and this
      // call, matching the same pattern used by approve/merge immediately above.
      const updateSha = action.expectedHeadSha ?? ctx.headSha;
      /* v8 ignore next -- the step-5 freshness guard above already denies the action when
       * action.expectedHeadSha ?? ctx.headSha is falsy, so updateSha (the same expression) is always a
       * truthy string here; the ?? undefined only satisfies updatePullRequestBranch's string|undefined type. */
      await updatePullRequestBranch(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, updateSha ?? undefined);
      return;
    }
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
    // staged close, silently defeating the breaker for the entire approval-queue accept path (#2127).
    ...(action.closeKind !== undefined ? { closeKind: action.closeKind } : {}),
    // Round-trip the CI dependency separately from closeKind: closeKind is intentionally broad (gate-verdict /
    // duplicate / slop / CI) for the close-precision breaker, but only red-CI closes need the live-CI guard.
    ...(action.closeRequiresCiState !== undefined ? { closeRequiresCiState: action.closeRequiresCiState } : {}),
    // Round-trip the concrete-evidence tag so the breaker's exemption still applies when a staged close accepts.
    ...(action.closeConcreteEvidence !== undefined ? { closeConcreteEvidence: action.closeConcreteEvidence } : {}),
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
