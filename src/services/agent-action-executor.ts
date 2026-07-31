import {
  bumpPullRequestMergeAttempt,
  countModerationViolationsForActor,
  countRecentAuditEventsForActorAndTarget,
  createPendingAgentActionIfAbsent,
  getGlobalContributorBlacklist,
  getGlobalModerationConfig,
  insertNotificationDeliveryIfAbsent,
  isGlobalAgentFrozen,
  listOtherOpenPullRequests,
  listRepoPullRequestFilePaths,
  markPullRequestApproved,
  markPullRequestMergeBlocked,
  recordAuditEvent,
  recordModerationViolation,
  upsertGlobalContributorBlacklist,
} from "../db/repositories";
import { isPagerDutyEnabled, triggerPagerDutyIncident } from "./notify-pagerduty";
import { isAuthorBlacklisted } from "../settings/contributor-blacklist";
import { classifyMergeFailure, INFRA_MERGE_BLOCK_TTL_MS, isMergeConflictMessage, isNoNewBaseCommitsMessage, isWorkflowScopeRefusalMessage, MERGE_RETRY_CAP } from "./merge-failure";
import { notifyActionToDiscord, notifyActionToSlack, type NotifyOutcome } from "./notify-discord";
import { recordTerminalActionOutcome, resolveDispositionReason } from "../review/outcomes-wire";
import { cancelInFlightWorkflowRunsForHeadSha, createInstallationToken, githubErrorStatus, isGitHubRateLimitedError } from "../github/app";
import { fetchLiveCiAggregate, fetchLivePullRequestMergeState, fetchLivePullRequestState, fetchLiveReviewThreadBlockers, refreshInstallationHealthForInstallation } from "../github/backfill";
import { forcedSelfhostMode, githubRateLimitAdmissionKeyForToken } from "../github/client";
import { ensurePullRequestAssignee } from "../github/assignees";
import { ensurePullRequestLabel, removePullRequestLabel } from "../github/labels";
import { closeIssue, closePullRequest, createIssueComment, createPullRequestReview, dismissLatestBotApproval, mergePullRequest, updatePullRequestBranch } from "../github/pr-actions";
import { createOrUpdateCloseExplanationComment } from "../github/comments";
import { fetchPullRequestFreshness, pullRequestFreshnessDetail } from "../github/pr-freshness";
import { isActingAutonomyLevel, resolveAutonomy } from "../settings/autonomy";
import { boundStructuredCloseReasonsForPersistence, buildAgentActionAudit, formatAgentPermissionDenial, isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness, type AgentActionMode } from "../settings/agent-execution";
import { AGENT_LABEL_NEEDS_REVIEW, type PlannedAgentAction } from "../settings/agent-actions";
import type { AgentActionClass, AgentPendingActionParams, AutonomyLevel, AutonomyPolicy } from "../types";
import { clearPullRequestManualReviewLabelProvenance, markPullRequestManualReviewLabelApplied } from "../db/repositories";
import { errorMessage } from "../utils/json";
import {
  MODERATION_VIOLATION_EVENT_TYPE,
  moderationTierForViolationCount,
  resolveEffectiveModerationRules,
  resolveModerationGateEnabled,
  type ModerationRuleType,
  type ModerationTier,
} from "../settings/moderation-rules";
import { incr } from "../selfhost/metrics";
import { MERGE_TRAIN_MAX_WAIT_MS, shouldWaitForOlderSiblings } from "../review/merge-train";
import { capturePostHogError } from "../selfhost/posthog";
import { claimContributorCapLock, releaseContributorCapLock } from "../queue/transient-locks";
import { buildDecisionRecord, persistDecisionRecord, type DecisionRecord, type ReevaluationContext } from "../review/decision-record";

// The agent actor name on every audit record — the App acts on the maintainer's behalf per their configured
// autonomy (the config IS the authorization; there is no human commenter to authorize, unlike #824).
const AGENT_ACTOR = "loopover";

// #9039 wedge alert: how many recent merge-train denials against the SAME blocking sibling, within
// MERGE_TRAIN_WEDGE_WINDOW_MS, mean the train is genuinely stalled behind one PR rather than a one-off
// ordering hiccup that clears itself in seconds (the only other observed train-wait episode, behind #8925,
// cleared in 20 seconds). Deliberately lower than ops-wire.ts's analogous REVIEW_FAILURE_BURST_THRESHOLD (3
// over 2h) would suggest for a "rare, error-grade" condition, because a wedge is a harder stop than that
// burst: it zeroes throughput for EVERY overlapping PR queued behind the blocker, not just the one repeatedly-
// retried PR, so it should page sooner. A 1h window catches a wedge well inside its first hour -- far ahead of
// both the 24h staleness cap and the 4h it took a human to notice the confirmed #8735 incident (57 denials,
// 5 PRs blocked).
const MERGE_TRAIN_WAIT_COMMENT_EVENT_TYPE = "agent.action.merge_train_wait_comment";
const MERGE_TRAIN_WEDGE_ALERT_THRESHOLD = 5;
const MERGE_TRAIN_WEDGE_WINDOW_MS = 60 * 60 * 1000;
const MERGE_TRAIN_WEDGE_EVENT_TYPE = "agent.action.merge_train_blocked";

// Bound on audit_events.detail / the reason embedded in buildAgentActionAudit (#terminal-outcome-audit). A
// heuristic close/hold reason is built by joining every blocker's title (agent-actions.ts), so an unbounded PR
// with many blockers could otherwise write an arbitrarily large string; matches the existing 280-char bound
// already used for mergeBlockedReason (db/repositories.ts) and the merge_blocked audit metadata below.
const AUDIT_REASON_MAX_LENGTH = 280;

function boundAuditReason(detail: string): string {
  return detail.length > AUDIT_REASON_MAX_LENGTH ? `${detail.slice(0, AUDIT_REASON_MAX_LENGTH)}…` : detail;
}

function closeReasonsForAudit(action: PlannedAgentAction): { closeReasons: string[]; closeReasonCount: number } | undefined {
  if (action.actionClass !== "close") return undefined;
  const rawReasons = action.closeReasons?.length ? action.closeReasons : [action.reason];
  // Bound the COUNT first (a cheap slice) so the per-reason string truncation below only ever runs over the
  // persisted subset, never a potentially unbounded array -- the ORIGINAL count is carried separately as
  // closeReasonCount so buildAgentActionAudit can still flag truncation correctly even though closeReasons
  // itself is already bounded by the time it gets there (#3213 review: an unbounded .map(boundAuditReason)
  // here could exhaust Worker CPU/memory before any cap ran).
  return {
    closeReasons: boundStructuredCloseReasonsForPersistence(rawReasons).map((reason) => boundAuditReason(reason)),
    closeReasonCount: rawReasons.length,
  };
}

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
const PR_WRITE_DENIAL_COOLDOWN_MAX_ENTRIES = 1024;
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
function pruneWritePermissionDenialCooldown(nowMs: number): void {
  for (const [key, lastDeniedMs] of writePermissionDenialCooldown) {
    if (nowMs - lastDeniedMs >= PR_WRITE_DENIAL_COOLDOWN_MS) writePermissionDenialCooldown.delete(key);
  }
}

function evictOldestWritePermissionDenialCooldownEntry(): void {
  const oldestKey = writePermissionDenialCooldown.keys().next().value as string;
  writePermissionDenialCooldown.delete(oldestKey);
}

function shouldSuppressWritePermissionDenial(key: string, nowMs: number): boolean {
  pruneWritePermissionDenialCooldown(nowMs);
  const lastDeniedMs = writePermissionDenialCooldown.get(key);
  return lastDeniedMs !== undefined && nowMs - lastDeniedMs < PR_WRITE_DENIAL_COOLDOWN_MS;
}

/** Arms (or refreshes) the write-permission-denial cooldown -- call ONLY after the loud audit write for this
 *  exact denial has actually succeeded, so a failed audit write is retried on the very next pass instead of
 *  being silently suppressed for the whole cooldown window. */
function markWritePermissionDenialAudited(key: string, nowMs: number): void {
  pruneWritePermissionDenialCooldown(nowMs);
  if (writePermissionDenialCooldown.size >= PR_WRITE_DENIAL_COOLDOWN_MAX_ENTRIES) evictOldestWritePermissionDenialCooldownEntry();
  writePermissionDenialCooldown.set(key, nowMs);
}

/** Test-only: clear the module-level write-permission denial cooldown so each test starts fresh. */
export function clearWritePermissionDenialCooldownForTest(): void {
  writePermissionDenialCooldown.clear();
}

/** Test-only: inspect the module-level write-permission denial cooldown size. */
export function writePermissionDenialCooldownSizeForTest(): number {
  return writePermissionDenialCooldown.size;
}

export type AgentActionExecutionContext = {
  installationId: number;
  repoFullName: string;
  pullNumber: number;
  headSha?: string | null | undefined;
  // #9055: the base ORB last computed the diff/review/CI against. A contributor can retarget a PR's base with
  // the HEAD unchanged — the freshness check that already gates every merge/approve mutation sees nothing wrong
  // in that case, since it only compares head SHAs. Threaded through so the SAME live fetch that proves the
  // head also proves the base, denying a merge into an abandoned base rather than silently completing it.
  //
  // #9541 (deliverable 3): REQUIRED, not optional. `null` remains a valid value meaning "no base to check";
  // what is no longer expressible is OMITTING it. #9482 found this silently absent on the approval-accept
  // path, which made #9055's base-retarget guard inert there -- a wrong-merge class -- purely because the
  // type allowed the omission. Follows #9539's required `decisionNowMs` precedent: a protection whose
  // ABSENCE disables it rather than degrading it must be a type error to leave out.
  expectedBaseRef: string | null;
  autonomy: AutonomyPolicy | null | undefined;
  agentPaused?: boolean | undefined;
  agentDryRun?: boolean | undefined;
  installationPermissions: Record<string, string> | null | undefined;
  // PR author login — surfaced as the "Submitter" in the per-repo Discord action notification.
  //
  // #9541: REQUIRED for the same reason, and this one had TWO silent failures when omitted (#9482). Step 8c's
  // cap-lock key degrades to `contributor-cap-lock:<repo>:` with an empty author -- zero exclusion, and every
  // accept-path merge in the repo contending on one shared key. And maybeEscalateModeration early-returns on
  // a falsy author, so enforcement closes recorded no violation and never counted toward the ban threshold.
  authorLogin: string | null;
  // CI-run cancellation on a contributor_cap close (#2462, anti-abuse): the CALLER resolves this (repo setting
  // ?? the CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var) before building the context — the executor itself has no
  // settings access, only whatever ctx carries, mirroring how agentPaused/agentDryRun are already threaded in.
  contributorCapCancelCi?: boolean | undefined;
  // Pre-merge contributor-cap re-check (#7284-fix, TOCTOU race): a caller-supplied closure (closed over the
  // repo's settings/token, resolved before this ctx was built — same "the executor has no settings access"
  // shape as every other field here) the executor calls, under the per-(repo, author) mutex
  // (claimContributorCapLock), immediately before actually executing a merge. Returns true when still safe to
  // merge, false when a fresh check confirms the author is NOW over cap (a sibling opened/closed since this
  // PR's own cap check earlier in its pipeline pass) — the executor records a "denied" outcome and skips the
  // merge (same idiom as every other pre-condition denial in this loop) rather than duplicating close-planning
  // logic inline; the next natural re-evaluation (webhook/sweep) plans a close off the current, accurate cap
  // state. Absent when the caller has no cap configured for this repo — merge proceeds exactly as before this
  // field existed, zero added cost.
  contributorCapMergeRecheck?: (() => Promise<boolean>) | undefined;
  // Moderation-rules engine (#selfhost-mod-engine): the repo's PER-REPO override fields, resolved by the
  // CALLER from RepositorySettings before building the context (same "the executor has no settings access"
  // shape as contributorCapCancelCi above). Absent/undefined ⇒ inherit the global config's own defaults. The
  // GLOBAL config itself (whole-layer enabled, threshold, decay, auto-blacklist) is read directly by the
  // executor via getGlobalModerationConfig -- a single extra DB read only on the rare path where a
  // moderation-tracked close actually completed, not threaded through every caller.
  //
  // #9541: REQUIRED. `null` means "inherit the global config's defaults" -- exactly what an absent value used
  // to mean. The difference is that choosing it is now visible at the call site rather than being the
  // accidental result of forgetting the field.
  moderationSettings: ModerationContextSettings | null;
  // Effective required CI contexts (#selfhost-ci-verification), resolved by the CALLER (same "the executor has
  // no settings access" shape as the fields above): the final pre-mutation live-CI re-verification (step 8 below)
  // must honor the SAME branch-protection-plus-expected required-contexts view the planning pass already
  // evaluated against. Absent/undefined ⇒ fold-all mode, unchanged from before this field existed.
  requiredCiContexts?: ReadonlySet<string> | null | undefined;
  // settings.advisoryCheckRuns (#4372), resolved by the CALLER (same "no settings access" shape as
  // requiredCiContexts above): the step-8 live-CI re-verification must apply the SAME advisory-check-run
  // exclusion the planning pass used — otherwise the executor could see a maintainer-declared advisory check as
  // failing/pending and block a merge the planner already cleared. Absent ⇒ exclusion off, unchanged from before.
  advisoryCheckRuns?: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
  // #9810: the ignore list, resolved by the CALLER exactly like advisoryCheckRuns above.
  ignoredCheckRuns?: ReadonlyArray<{ name: string; appSlug: string }> | null | undefined;
  // settings.manualReviewLabel (#3472 split-brain), resolved by the CALLER (same "the executor has no settings
  // access" shape as requiredCiContexts above): the approve/merge live label guard (step 7b below) needs the
  // SAME configured label name the planner itself resolves labels.manualReview from (agent-actions.ts), so a
  // custom label name is honored instead of only ever checking the literal default. `null` explicitly disables
  // the manual-review label (and this guard with it); absent/undefined uses the default AGENT_LABEL_NEEDS_REVIEW.
  manualReviewLabel?: string | null | undefined;
  // Merge-train FIFO gate (#selfhost-merge-train), resolved by the CALLER (same "the executor has no settings
  // access" shape as the fields above): "off" (default, unchanged behavior) | "audit" (log what would be held,
  // never actually hold) | "enforce" (actually defer a merge behind a still-viable older sibling). Absent/
  // undefined behaves exactly like "off".
  mergeTrainMode?: "off" | "audit" | "enforce" | undefined;
  // This PR's own creation time, resolved by the CALLER (already has the PR record in scope) — the merge-train
  // gate below compares this against open siblings fetched fresh, since siblings are only ever fetched lazily
  // when the gate is actually enabled (see step 8b), not threaded through every caller unconditionally.
  pullRequestCreatedAt?: string | null | undefined;
  // This PR's own linked issues (#selfhost-merge-train-overlap), resolved by the CALLER (already has the PR
  // record in scope): the merge-train gate only holds a merge behind an OVERLAPPING older sibling (shared
  // linked issue or shared meaningful changed file), never a blanket "any older PR" wait -- see
  // merge-train.ts's module header for why. Absent/undefined behaves like an empty list (issue-overlap never
  // matches; file-overlap can still apply via pullRequestChangedFiles below).
  pullRequestLinkedIssues?: readonly number[] | undefined;
  // This PR's own changed file paths, when the caller has them resolved (e.g. a webhook path with the
  // `pull_request_files` cache already populated). Absent/undefined degrades the merge-train overlap check to
  // linked-issue-only for this PR, never to "no overlap possible".
  pullRequestChangedFiles?: readonly string[] | undefined;
  // #9134: every completed merge/close MUST emit a decision record + chained ledger row -- resolved by the
  // CALLER (same "the executor has no settings access" shape as contributorCapCancelCi/manualReviewLabel
  // above) and REQUIRED (not optional), so a NEW call site cannot compile without deciding what its record
  // should carry. Before this field existed, buildDecisionRecord/persistDecisionRecord ran at exactly ONE of
  // this executor's seven call sites (the gate-evaluation plan-and-execute path) -- and there UNCONDITIONALLY,
  // for the disposition it PLANNED regardless of hold/merge/close and regardless of whether the plan actually
  // executes cleanly (that site's own doc comment explains why: a hold never even reaches this executor, so
  // its record has to be built before that early return). The other six call sites -- a contributor-cap close
  // on PR open, two review-nag closes, an approval-queue accept, and two forced-rebase update_branch calls --
  // wrote no record and no ledger row at all, silently biasing the risk-control calibration join
  // (loadCalibrationPairs) away from exactly the closes a contributor is most likely to dispute. Set
  // `managedByCaller: true` ONLY for a call site that already builds its own record independently of this
  // executor's completed-action outcome (today: just the one gate-evaluation site, for the hold reason above)
  // -- passing it silently is a deliberate, self-documenting override, not an accidental omission, which is
  // the actual property this field being required protects.
  decisionRecord: DecisionRecordContext;
};

/** See `AgentActionExecutionContext.decisionRecord`'s doc comment for why this exists, is required, and has an
 *  explicit opt-out. */
export type DecisionRecordContext =
  | { managedByCaller: true }
  | {
      managedByCaller?: false | undefined;
      /** Digest of the RESOLVED effective settings in force for this decision (canonical JSON) -- the ONE
       *  field every caller must actually resolve; every other field defaults to null/a generic derivation
       *  below when a caller has nothing richer to say. Compute via `contentDigest(settings)`
       *  (decision-record.ts) the SAME way the gate-evaluation call site already does. */
      configDigest: string;
      /** #9742: WHY this evaluation is running, for the case where the head SHA already carries a
       *  verdict. REQUIRED, and deliberately not defaulted: a repeat verdict whose cause nobody
       *  declared is exactly what this invariant exists to refuse, so a future call site must answer
       *  it at the type level rather than inherit a plausible-looking guess. Callers driven by a job
       *  derive it with `deriveReevaluationReason(deliveryId)`; a human-driven one names its own
       *  cause. Ignored entirely on a first evaluation, which is most writes. */
      reevaluation: ReevaluationContext;
      gatePack?: string | null | undefined;
      ciState?: string | null | undefined;
      baseSha?: string | null | undefined;
      // #9124: renamed from the singular `modelId` -- these call sites (contributor-cap close, review-nag
      // close, update_branch) have no AI judgment behind them today, so this is always omitted in practice,
      // but the shape matches DecisionRecord.modelIds (the FULL parsed-reviewer set) rather than a single id.
      modelIds?: string[] | null | undefined;
      promptDigest?: string | null | undefined;
      aiConfidence?: number | null | undefined;
      salvageability?: { score: number; factors: string[] } | null | undefined;
      /** Override the generic reasonCode derivation (see `defaultDecisionRecordReasonCode` below) -- a caller
       *  with richer blockerClass/gate.conclusion context this executor has no way to derive generically
       *  passes its own `deriveDecisionReasonCode` result here instead. */
      reasonCode?: string | undefined;
      /** Called once, best-effort, immediately after a completed merge/close action's record is persisted --
       *  lets a caller with a sibling private row to write (e.g. a decision-replay input, keyed to the exact
       *  SAME record id) act on the id this call actually wrote, including a supersession's revisioned id
       *  (#9123) rather than recomputing a possibly-stale base id independently. Never invoked when the
       *  persist itself failed (persistDecisionRecord already swallows that and warns; recordCompletedDecision
       *  below treats a null id the same way). */
      afterPersist?: ((recordId: string, record: DecisionRecord) => Promise<void> | void) | undefined;
    };

/** Generic reasonCode when the caller has no richer derivation of its own (see DecisionRecordContext.reasonCode
 *  above). A policy-tagged close (contributor_cap / blacklist / review_nag / heuristic / whatever closeKind the
 *  planner attached) publishes as `policy_close:<kind>`, the SAME convention deriveDecisionReasonCode
 *  (decision-replay.ts) already uses for a policy close's blockerClass-less case; a plain merge, or a close
 *  with no closeKind at all, publishes as "success" -- there is no blocker to name and the action itself IS
 *  the verdict. Exported for direct unit testing. */
export function defaultDecisionRecordReasonCode(action: PlannedAgentAction): string {
  return action.closeKind !== undefined ? `policy_close:${action.closeKind}` : "success";
}

/**
 * #9134: emit the decision record + chained ledger row for a JUST-COMPLETED merge/close action, by
 * construction -- called from the SAME "completed" branch every call site's mutation funnels through (step 9
 * below), so a new call site cannot add a merge/close outcome without also going through this (unless it
 * opted out via `managedByCaller: true` — see DecisionRecordContext's doc comment for the one site that does).
 * Best-effort, mirroring persistDecisionRecord's own posture: recording legibility must never fail a mutation
 * that already succeeded on GitHub -- callers wrap this in `.catch(() => undefined)`.
 */
async function recordCompletedDecision(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction): Promise<void> {
  if (ctx.decisionRecord.managedByCaller === true) return;
  const dr = ctx.decisionRecord;
  /* v8 ignore next -- the step-5 freshness guard above already denies a merge/close (this function only ever
   * runs for those two classes) whenever action.expectedHeadSha ?? ctx.headSha is falsy, so this is always a
   * truthy string by the time a completed merge/close reaches here; the "unknown" fallback only satisfies
   * buildDecisionRecord's required string headSha field, mirroring the exact same defensive pattern the
   * merge/approve cases in performAction already use for this identical expression. */
  const headSha = action.expectedHeadSha ?? ctx.headSha ?? "unknown";
  const { record, recordDigest } = await buildDecisionRecord({
    repoFullName: ctx.repoFullName,
    pullNumber: ctx.pullNumber,
    headSha,
    baseSha: dr.baseSha ?? null,
    action: action.actionClass,
    reasonCode: dr.reasonCode ?? defaultDecisionRecordReasonCode(action),
    configDigest: dr.configDigest,
    // #9124: for every call site that reaches this generic path, configDigest already IS the raw resolved-
    // settings digest (there is no separate gateCheckPolicy resolution behind a policy close or update_branch)
    // -- so settingsDigest is honestly the same value, not a guess.
    settingsDigest: dr.configDigest,
    gatePack: dr.gatePack ?? null,
    ciState: dr.ciState ?? null,
    modelIds: dr.modelIds ?? null,
    promptDigest: dr.promptDigest ?? null,
    aiConfidence: dr.aiConfidence ?? null,
    salvageability: dr.salvageability ?? null,
  });
  const recordId = await persistDecisionRecord(env, record, recordDigest, 3, dr.reevaluation);
  if (recordId !== null && dr.afterPersist) await dr.afterPersist(recordId, record);
}

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
  return plan.some((action, index) => action.actionClass === "label" && action.closeKind === "linked-issue-hard-rule" && action.labelOp === "add" && outcomes[index]?.outcome === "completed");
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
 *   API budget) → label/close correlation → freshness → manual-review hold (approve/merge only, #3472) →
 *   live-CI re-verification → the real mutation.
 * Only `live` mode performs a real mutation; `dry_run` records what it WOULD do. Every path writes one
 * `agent.action.<class>` audit record (#776) EXCEPT a write-permission denial repeated within
 * PR_WRITE_DENIAL_COOLDOWN_MS of the last one for the same installation/repo/PR/action-class, which is counted but
 * not re-audited (#selfhost-runtime-drift). A failed mutation is recorded as `error`, never swallowed.
 */
export async function executeAgentMaintenanceActions(env: Env, ctx: AgentActionExecutionContext, planned: PlannedAgentAction[]): Promise<AgentActionOutcome[]> {
  const outcomes: AgentActionOutcome[] = [];
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  // globalPaused folds the env-var brake AND the DB-backed kill-switch (#audit-§5.2) so an operator can halt the
  // fleet instantly via one DB row, without a redeploy.
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), instanceMode: forcedSelfhostMode(env), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

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
      const boundedDetail = boundAuditReason(detail);
      outcomes.push({ actionClass: action.actionClass, outcome, detail: boundedDetail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: boundedDetail, ...closeReasonsForAudit(action) }),
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
      // #9481: the audit is conditional on staging having actually happened. It used to fire unconditionally,
      // so when staging no-op'd against an existing row every later sweep still recorded "awaiting maintainer
      // approval" -- an audit trail asserting a notification that was never sent.
      const staged = await stageForApproval(env, ctx, action, autonomyLevel);
      if (staged) await audit("queued", `awaiting maintainer approval — ${action.reason}`);
      continue;
    }
    // 5) Write-permission readiness: a PR-visible action needs its exact GitHub App write permission granted.
    //    Merge is Contents: write, while review/close/update_branch are Pull requests: write. Checked here
    //    before the freshness/live-CI GitHub calls below so a known-denied action never spends that API budget on
    //    an outcome that cannot change until the maintainer re-consents (#selfhost-runtime-drift).
    if (PR_WRITE_CLASSES.has(action.actionClass) && resolveAgentPermissionReadiness({ autonomy: ctx.autonomy, installationPermissions: ctx.installationPermissions, actionClass: action.actionClass }) !== "ready") {
      incr("loopover_agent_action_permission_denied_total", { actionClass: action.actionClass });
      const cooldownKey = writePermissionDenialKey(ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.actionClass);
      if (shouldSuppressWritePermissionDenial(cooldownKey, Date.now())) {
        // Already denied + audited for this exact installation/repo/action-class within the cooldown window --
        // count it (the denial stays visible in metrics) without re-writing an identical audit record every pass.
        incr("loopover_agent_action_permission_denied_suppressed_total", { actionClass: action.actionClass });
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
    let pairedCloseOutcome: AgentActionOutcome["outcome"] | undefined;
    if (action.actionClass === "label" && action.closeKind) {
      pairedCloseOutcome = coupledCloseOutcome(planned, outcomes, action.closeKind);
      if (pairedCloseOutcome === "denied" || pairedCloseOutcome === "error") {
        await audit("denied", `paired ${action.closeKind} close did not complete (${pairedCloseOutcome}) — skipping the companion label so the PR isn't mislabeled while still open`);
        continue;
      }
    }
    // 7) Freshness guard: every supported live action mutates PR state or PR-visible output, so it must still
    //    target the reviewed, open head. This protects approval-queue replays and slow webhook jobs from
    //    force-pushes or manual closes that happen after the review was planned. A companion anti-abuse label
    //    whose paired close just completed in this same batch reuses the close's already-passed guard: the
    //    successful close intentionally flips the PR to closed, so a second open-PR freshness read would deny
    //    the label for the state transition this executor just performed.
    const expectedHeadSha = action.expectedHeadSha ?? ctx.headSha ?? null;
    const freshnessAlreadyProvenByPairedClose = action.actionClass === "label" && action.closeKind !== undefined && pairedCloseOutcome === "completed";
    if (!freshnessAlreadyProvenByPairedClose) {
      if (!expectedHeadSha) {
        await audit("denied", "live PR head guard unavailable — action not executed");
        continue;
      }
      const freshness = await fetchPullRequestFreshness(env, {
        installationId: ctx.installationId,
        repoFullName: ctx.repoFullName,
        pullNumber: ctx.pullNumber,
        expectedHeadSha,
        expectedBaseRef: ctx.expectedBaseRef,
      });
      if (freshness.status !== "current") {
        await audit("denied", `${pullRequestFreshnessDetail(freshness)} — action not executed`);
        continue;
      }
      // 7b) Manual-review hold guard (#3472 split-brain): approve/merge is planned from a snapshot (the DB's
      // cached pr.labels, or a plan staged earlier for approval) that can predate a SIBLING pass for this exact
      // PR/head publishing a manual-review hold (label + assign) while THIS pass's own — possibly much slower —
      // AI review or gate evaluation was still in flight. The per-PR actuation lock (#2129) only serializes each
      // pass's plan-and-execute critical section; it does not make one pass aware of another's disposition, and
      // the stored PR row can itself lag the live label write by a full webhook round-trip. Re-check the SAME
      // live fetch that just proved this head is current (no extra GitHub call) for the configured manual-review
      // label: if present, a hold is standing for this exact head and must not be silently overridden by a
      // merit verdict computed before that hold existed. Only a maintainer removing the label, or a new commit
      // (which the freshness check above already denies as stale), lifts it.
      if (action.actionClass === "approve" || action.actionClass === "merge") {
        const manualReviewLabel = ctx.manualReviewLabel === null ? null : (ctx.manualReviewLabel ?? AGENT_LABEL_NEEDS_REVIEW);
        if (manualReviewLabel !== null && freshness.liveLabels.some((label) => label.toLowerCase() === manualReviewLabel.toLowerCase())) {
          await audit("denied", `manual-review label "${manualReviewLabel}" is present on the live PR — ${action.actionClass} not executed`);
          continue;
        }
      }
    }
    // 8) Live CI re-verification for a merge or a CI-driven heuristic close (#2128): the CI aggregate that drove
    //    either decision was read seconds-to-tens-of-seconds earlier, in the planning pass, and the freshness
    //    guard above only re-checks head SHA/state, not CI. GitHub's own merge endpoint enforces
    //    branch-protection REQUIRED checks server-side, but only as a backstop when a repo actually configures
    //    them; a red-CI close has no server-side check at all. Re-read live CI right before the mutation so a
    //    check that flipped in this narrow window is never acted on from stale information. Non-CI closes whose
    //    justification has no cheap live re-derivation (gate verdict, duplicate/slop, linked-issue hard-rule,
    //    blacklist) are exempt from THIS specific CI recheck — their adverse signal does not depend on CI still
    //    being red. A base conflict and an unresolved review thread DO have cheap live signals and get their own
    //    dedicated rechecks below (requiresLiveMergeableRecheck / requiresLiveThreadRecheck) instead.
    //    A heuristic close staged BEFORE #2478 has no closeRequiresCiState at all -- that field didn't exist yet
    //    -- so `undefined` here is genuinely ambiguous (a legacy CI-driven close and a legacy non-CI close are
    //    byte-identical in storage). The planner now ALWAYS sets the field going forward (never omits it), so
    //    `undefined` can only mean a legacy row; treat it with the old, broader pre-#2478 guard (require CI still
    //    failed) rather than skipping the recheck, which would let a stale CI-driven close silently execute
    //    after CI recovers (flagged by the gate's own review of #2478).
    const isAmbiguousLegacyHeuristicClose = action.actionClass === "close" && action.closeKind === "heuristic" && action.closeRequiresCiState === undefined;
    const requiresLiveCiRecheck = action.actionClass === "merge" || (action.actionClass === "close" && action.closeRequiresCiState === "failed") || isAmbiguousLegacyHeuristicClose;
    // #3863: a base-conflict-justified heuristic close (closeRequiresMergeableState === true) is read from the
    // SAME planning-pass snapshot as the CI check above -- an unrelated PR merging into the base branch during
    // a slow review pass (AI review, gate evaluation) can clear the conflict before this mutation runs, and
    // nothing re-verified it right before acting. The approval-queue's accept-time path already does this SAME
    // live re-check for a STAGED close (agent-approval-queue.ts); this is the immediate, same-pass execution
    // path, which had no equivalent.
    const requiresLiveMergeableRecheck = action.actionClass === "close" && action.closeKind === "heuristic" && action.closeRequiresMergeableState === true;
    // #review-thread-staleness: mirrors requiresLiveMergeableRecheck's exact shape (#3863) -- a review-thread-
    // justified heuristic close is read from the SAME planning-pass snapshot, and a contributor clicking
    // "Resolve conversation" on GitHub during a slow review pass clears it before this mutation runs, same as
    // an unrelated PR clearing a base conflict. Same immediate, same-pass execution path gap as #3863 had.
    const requiresLiveThreadRecheck = action.actionClass === "close" && action.closeKind === "heuristic" && action.closeRequiresThreadResolved === true;
    // #dup-winner-staleness: a duplicate-justified heuristic close (closeRequiresDuplicateStillOpen === true) is
    // likewise read from the planning-pass snapshot -- otherOpenPullRequests is reconciled ONCE up front
    // (reconcileLiveDuplicateSiblings), before the often-slow AI-review/gate-evaluation pass runs, and never
    // re-verified before this mutation. Unlike a conflict, the fact that can go stale here lives on a SIBLING
    // PR (it can be closed/merged independently, asynchronously, any time after this pass started), so only a
    // close that named a SPECIFIC winning sibling (duplicateWinnerPrNumber) has a cheap single-PR live signal
    // to re-check; one that didn't (flag off, or an ambiguous election) has no equivalently cheap re-derivation
    // and is left as a no-op here, matching closeRequiresMergeableState's own "false ⇒ skip" scoping above.
    const requiresLiveDuplicateRecheck =
      action.actionClass === "close" && action.closeKind === "heuristic" && action.closeRequiresDuplicateStillOpen === true && action.duplicateWinnerPrNumber !== undefined;
    // #8758: an APPROVE is likewise planned from the planning-pass snapshot, and the planner never approves a
    // "dirty" (about-to-close conflict) or "unstable" (merge self-suppresses, unstable hold) mergeable state —
    // but nothing re-verified that right before posting the formal review. A check flipping red in the window
    // between planning and actuation used to yield exactly #8711's incoherence: an approval claiming "gate
    // satisfied and CI green" on a PR the same plan's merge arm would refuse. Same live signal the #3863
    // conflict recheck already uses; one extra GET per approve (approves fire at most once per head).
    const requiresLiveApproveMergeableRecheck = action.actionClass === "approve";
    if (requiresLiveCiRecheck || requiresLiveMergeableRecheck || requiresLiveThreadRecheck || requiresLiveDuplicateRecheck || requiresLiveApproveMergeableRecheck) {
      const ciToken = await createInstallationToken(env, ctx.installationId).catch(() => undefined);
      const admissionKey = githubRateLimitAdmissionKeyForToken(env, ciToken, ctx.installationId);
      const [liveCi, liveMergeableState, liveThreadBlockers, liveWinnerState] = await Promise.all([
        requiresLiveCiRecheck
          ? fetchLiveCiAggregate(env, ctx.repoFullName, expectedHeadSha, ciToken, ctx.requiredCiContexts ?? null, admissionKey, ctx.advisoryCheckRuns ?? null, ctx.ignoredCheckRuns ?? null)
          : Promise.resolve(undefined),
        requiresLiveMergeableRecheck || requiresLiveApproveMergeableRecheck
          ? fetchLivePullRequestMergeState(env, ctx.repoFullName, ctx.pullNumber, ciToken, admissionKey)
          : Promise.resolve(undefined),
        requiresLiveThreadRecheck ? fetchLiveReviewThreadBlockers(env, ctx.repoFullName, ctx.pullNumber, ciToken, admissionKey) : Promise.resolve(undefined),
        requiresLiveDuplicateRecheck
          ? fetchLivePullRequestState(env, ctx.repoFullName, action.duplicateWinnerPrNumber!, ciToken, admissionKey).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      // The planner itself only ever stages a merge when ciState === "passed" exactly (reviewGood in
      // agent-actions.ts; "pending" short-circuits to no actions at all upstream) -- the live re-check must
      // require the SAME exact state, not just "not failed". Otherwise a check that regressed to pending or
      // became unreadable (unverified) between planning and actuation would still merge, on the assumption
      // that only an explicit failure invalidates the plan.
      const ciStaleReason = !requiresLiveCiRecheck
        ? null
        : action.actionClass === "merge"
          ? liveCi!.ciState !== "passed"
            ? `live CI is no longer passing (now: ${liveCi!.ciState})`
            : null
          // isAmbiguousLegacyHeuristicClose falls back to "failed" (the old unconditional requirement); an
          // explicitly-tagged fresh close compares against its own recorded requirement.
          : liveCi!.ciState !== (action.closeRequiresCiState ?? "failed")
            ? `CI state changed since planning (now: ${liveCi!.ciState})`
            : null;
      // Only a CONFIRMED "clean" clears a conflict-justified close -- an ambiguous/unresolvable live read
      // (unknown, unstable, blocked, or a failed fetch, which resolves to undefined) is not proof the conflict
      // resolved, matching the approval-queue's own fail-safe-toward-keeping-the-close precedent (#3863).
      const mergeableStaleReason =
        requiresLiveMergeableRecheck && liveMergeableState === "clean" ? "the base-branch conflict that justified this close has since cleared" : null;
      // Only a CONFIRMED empty result clears a thread-justified close -- fetchLiveReviewThreadBlockers already
      // fails open to [] on its own internal GraphQL error, so `undefined` here means the Promise.resolve(undefined)
      // no-op arm (requiresLiveThreadRecheck was false) rather than a genuine "no threads left" signal, matching
      // the mergeable-state recheck's own fail-safe-toward-keeping-the-close precedent above.
      const threadStaleReason =
        requiresLiveThreadRecheck && liveThreadBlockers !== undefined && liveThreadBlockers.length === 0
          ? "the review thread(s) that justified this close are now all resolved"
          : null;
      // Only a CONFIRMED non-"open" clears a duplicate-justified close -- a failed/ambiguous fetch (undefined)
      // fails open exactly like the mergeable-state recheck above, so a transient GitHub hiccup never wrongly
      // spares a close that is, in fact, still justified.
      const duplicateStaleReason =
        requiresLiveDuplicateRecheck && liveWinnerState !== undefined && liveWinnerState !== "open"
          ? `duplicate-cluster winner #${action.duplicateWinnerPrNumber} is no longer open`
          : null;
      // #8758: only a CONFIRMED bad state suppresses the approve — a failed/ambiguous live read (undefined,
      // "unknown", null) fails OPEN, matching the planner's own posture (it approves those states too: an
      // approval is reversible and a transient fetch hiccup must not strand approval-required repos). Only the
      // two states the planner itself refuses to approve ("dirty", "unstable") deny here.
      const approveMergeableStaleReason =
        requiresLiveApproveMergeableRecheck && (liveMergeableState === "dirty" || liveMergeableState === "unstable")
          ? `live mergeable_state is now "${liveMergeableState}" — the planner never approves this state`
          : null;
      const staleReason = ciStaleReason ?? mergeableStaleReason ?? threadStaleReason ?? duplicateStaleReason ?? approveMergeableStaleReason;
      if (staleReason) {
        await audit("denied", `${staleReason} — action not executed`);
        continue;
      }
    }
    // 8b) merge-train FIFO gate (#selfhost-merge-train): a still-viable, OVERLAPPING older open sibling in this
    // repo holds this merge until it merges, closes, or goes stale (see merge-train.ts's staleness cap and its
    // module header for why overlap-scoping, not blanket FIFO, is the actual fix -- an unrelated older sibling
    // never blocks). #9039: a sibling held for manual review ALSO never blocks (see merge-train.ts's header for
    // the confirmed #8735 incident this fixes) -- it is evicted from the train the same as a git-conflicted
    // one, rather than treated as "still viable to eventually clear on its own." Siblings + their changed-file
    // paths are fetched fresh here, lazily, ONLY when the gate is actually enabled for this repo — not threaded
    // through every caller unconditionally, since the vast majority of merges never need this check. "audit"
    // mode logs the decision but never actually holds anything, so it's safe to enable everywhere to validate
    // the fix before switching a repo to "enforce".
    if (action.actionClass === "merge" && ctx.mergeTrainMode && ctx.mergeTrainMode !== "off") {
      const siblings = await listOtherOpenPullRequests(env, ctx.repoFullName, ctx.pullNumber);
      const filePaths = await listRepoPullRequestFilePaths(env, ctx.repoFullName, {
        pullNumbers: [ctx.pullNumber, ...siblings.map((sibling) => sibling.number)],
      });
      const pathsByPullNumber = new Map<number, string[]>();
      for (const row of filePaths) {
        const paths = pathsByPullNumber.get(row.pullNumber) ?? [];
        paths.push(row.path);
        pathsByPullNumber.set(row.pullNumber, paths);
      }
      // #9039: resolved the SAME way as the existing 7b manual-review guard just above (ctx.manualReviewLabel
      // `null` explicitly disables the label; absent/undefined falls back to AGENT_LABEL_NEEDS_REVIEW) so the
      // merge-train gate's notion of "held for manual review" can never drift from the rest of this executor's
      // own definition.
      const manualReviewLabel = ctx.manualReviewLabel === null ? null : (ctx.manualReviewLabel ?? AGENT_LABEL_NEEDS_REVIEW);
      const decision = shouldWaitForOlderSiblings({
        thisPrNumber: ctx.pullNumber,
        thisPrCreatedAt: ctx.pullRequestCreatedAt,
        thisPrLinkedIssues: ctx.pullRequestLinkedIssues ?? [],
        thisPrChangedFiles: pathsByPullNumber.get(ctx.pullNumber) ?? ctx.pullRequestChangedFiles,
        siblings: siblings.map((sibling) => ({
          number: sibling.number,
          createdAt: sibling.createdAt,
          mergeableState: sibling.mergeableState,
          linkedIssues: sibling.linkedIssues,
          changedFiles: pathsByPullNumber.get(sibling.number),
          heldForManualReview: manualReviewLabel !== null && sibling.labels.some((label) => label.toLowerCase() === manualReviewLabel.toLowerCase()),
          // #9939: a draft sibling never blocks -- GitHub will not merge it, so it is not "about to land".
          // `?? false` rather than passing the nullable straight through: the field is optional on the record
          // and the gate treats absent as "not a draft", so normalising here keeps the two readings identical.
          isDraft: sibling.isDraft ?? false,
        })),
        nowMs: Date.now(),
      });
      if (decision.wait) {
        incr("loopover_merge_train_deferred_total", { repo: ctx.repoFullName, mode: ctx.mergeTrainMode });
        // #9039 wedge detector: keyed to the BLOCKING sibling, not the waiting PR -- every DIFFERENT PR the
        // train denies behind the SAME stuck head counts toward one signal (the confirmed incident blocked 5
        // distinct PR numbers behind #8735; a per-waiting-PR counter would never have crossed a useful
        // threshold for any single one of them). Recorded in BOTH modes: an "audit"-mode would-wait and an
        // "enforce"-mode deny both mean the train is (or would be) stalled behind this exact sibling.
        const wedgeTargetKey = `${ctx.repoFullName}#merge-train-blocked-by-${decision.blockingPr}`;
        await recordAuditEvent(env, {
          eventType: MERGE_TRAIN_WEDGE_EVENT_TYPE,
          actor: AGENT_ACTOR,
          targetKey: wedgeTargetKey,
          outcome: "denied",
          detail: `merge train: blocked by sibling #${decision.blockingPr}`,
          metadata: { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, blockingPr: decision.blockingPr, mode: ctx.mergeTrainMode },
        }).catch(() => undefined);
        // Best-effort, flag-gated, fail-open sustained-wedge page -- mirrors ops-wire.ts's own PagerDuty wiring
        // exactly (same isPagerDutyEnabled/triggerPagerDutyIncident helpers, same "count recent audit rows,
        // page past a threshold" shape) rather than inventing a new alerting mechanism. No-op unless
        // LOOPOVER_ENABLE_PAGERDUTY is set AND a routing key resolves for this repo. triggerPagerDutyIncident
        // itself never throws, applies its own min-severity floor, and (via its dedup_key cooldown) never
        // re-pages every tick for a still-wedged train -- so calling it on every qualifying denial is safe.
        if (isPagerDutyEnabled(env)) {
          try {
            const sinceIso = new Date(Date.now() - MERGE_TRAIN_WEDGE_WINDOW_MS).toISOString();
            const recentDenials = await countRecentAuditEventsForActorAndTarget(env, AGENT_ACTOR, MERGE_TRAIN_WEDGE_EVENT_TYPE, wedgeTargetKey, sinceIso);
            if (recentDenials >= MERGE_TRAIN_WEDGE_ALERT_THRESHOLD) {
              await triggerPagerDutyIncident(env, {
                repoFullName: ctx.repoFullName,
                summary: `merge train wedged: #${decision.blockingPr} has blocked ${recentDenials} merge attempt(s) in the last hour`,
                severity: "error",
                dedupKey: wedgeTargetKey,
                customDetails: { blockingPr: decision.blockingPr, recentDenials, mode: ctx.mergeTrainMode },
              });
            }
          } catch (error) {
            console.warn(JSON.stringify({ event: "merge_train_wedge_alert_failed", repo: ctx.repoFullName, message: errorMessage(error).slice(0, 200) }));
          }
        }
        if (ctx.mergeTrainMode === "enforce") {
          // #merge-train-honest-comment (observed live on JSONbored/loopover#9837): the published surface said
          // the PR was MERGING -- the planner's disposition legitimately concluded wouldMerge before this
          // step-8 check ran -- and then this branch denied it with an AUDIT-ONLY record. Publicly the PR
          // claimed an action that never happened, which reads as the bot silently breaking its word.
          //
          // Post the truth once per (waiting PR, blocker) pair. Dedup via the AUDIT TRAIL, not a transient
          // lock: claimTransientLock fails OPEN ({acquired:true}) on any deployment without a transient
          // cache bound, which would repeat this comment on every denial pass -- and the comment's own audit
          // row is already the exact "did we say this" fact, durable on every deployment. The target key
          // carries the blocker so a NEW blocker (a genuinely new fact) gets its own line. Fail-open on the
          // comment itself: a post failure never blocks the denial bookkeeping.
          const waitCommentTargetKey = `${ctx.repoFullName}#${ctx.pullNumber}:merge-train-wait-comment-for-${decision.blockingPr}`;
          const alreadyToldSinceIso = new Date(Date.now() - MERGE_TRAIN_MAX_WAIT_MS).toISOString();
          const alreadyTold = await countRecentAuditEventsForActorAndTarget(env, AGENT_ACTOR, MERGE_TRAIN_WAIT_COMMENT_EVENT_TYPE, waitCommentTargetKey, alreadyToldSinceIso).catch(() => 0);
          if (alreadyTold === 0) {
            const posted = await createIssueComment(
              env,
              ctx.installationId,
              ctx.repoFullName,
              ctx.pullNumber,
              // #9952: name the POSITION, not just the PR in front. "behind #4" and "behind #4 and six
              // others" are very different waits, and a queue that will not say which one it is reads as a
              // stall rather than a wait. `queueAhead` is oldest-first, so its length is this PR's place in
              // line minus one. Only the immediate blocker is named when it is the only one ahead -- listing
              // a one-item queue as "1 PR ahead: #4" is noise.
              (decision.queueAhead.length > 1
                ? `Queued in the merge train at position ${decision.queueAhead.length + 1}, behind ${decision.queueAhead.length} overlapping PRs opened before this one (${decision.queueAhead.map((pr) => `#${pr}`).join(", ")}). ` +
                  `The nearest is #${decision.blockingPr}. This PR merges automatically as they complete (or leave the train). No action needed. `
                : `Queued in the merge train behind #${decision.blockingPr}, which touches overlapping work and was opened first. ` +
                  `This PR merges automatically once #${decision.blockingPr} completes (or leaves the train). No action needed. `) +
                `This is an automated maintenance action.`,
            ).then(() => true).catch(() => false);
            // Recorded ONLY after a successful post: a failed post leaves no row, so the next pass retries
            // rather than believing the contributor was told when they never were.
            if (posted) {
              await recordAuditEvent(env, {
                eventType: MERGE_TRAIN_WAIT_COMMENT_EVENT_TYPE,
                actor: AGENT_ACTOR,
                targetKey: waitCommentTargetKey,
                outcome: "completed",
                detail: `told the contributor this PR is queued behind #${decision.blockingPr}`,
                metadata: { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, blockingPr: decision.blockingPr },
              }).catch(() => undefined);
            }
          }
          await audit("denied", `merge train: waiting for older mergeable sibling #${decision.blockingPr} — action not executed`);
          continue;
        }
        // "audit" mode: record a SEPARATE, informational audit-trail entry (never through the shared `audit`
        // closure above, which pushes into the SAME outcomes[] this function returns -- calling it here too
        // would silently double the returned outcome count for this one action). The merge itself proceeds
        // unaffected below.
        await recordAuditEvent(env, {
          eventType: "agent.action.merge_train_would_wait",
          actor: "loopover",
          targetKey,
          outcome: "denied",
          detail: `merge train (audit mode): would wait for older mergeable sibling #${decision.blockingPr}`,
          metadata: { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, blockingPr: decision.blockingPr },
        }).catch(() => undefined);
      }
    }
    // 9) live — perform the real mutation, recording success or the error. Wrapped in a closure so 8c below can
    // hold the contributor-cap lock across this call for a merge (see 8c's own doc comment for why).
    const performMutation = async (): Promise<void> => {
      try {
        const detailOverride = await performAction(env, ctx, action);
        await audit("completed", detailOverride ?? action.reason);
        // #9134: every completed merge/close emits a decision record + chained ledger row, by construction --
        // see DecisionRecordContext's doc comment on why this lives HERE instead of at each call site. Never
        // throws: recording legibility must never retroactively fail a mutation that already succeeded.
        if (action.actionClass === "merge" || action.actionClass === "close") {
          await recordCompletedDecision(env, ctx, action).catch(() => undefined);
        }
        // CI-run cancellation on an anti-abuse close (#2462 contributor_cap; extended to blacklist #6659): stop
        // burning CI minutes on a PR that was just closed for exceeding the contributor cap, or for a banned
        // login. contributor_cap stays opt-in (contributorCapCancelCi) since a repo may want the cap to bite
        // without touching CI; blacklist is unconditional -- there is no scenario where a maintainer wants a
        // permanently-banned login's CI to keep running after the close. Best-effort, AFTER the close already
        // succeeded -- cancelInFlightWorkflowRunsForHeadSha never throws, so a missing actions:write grant (or
        // any other failure here) can never retroactively turn this already-successful close into a recorded
        // "error" by escaping into the catch block below.
        if (action.actionClass === "close" && ctx.headSha) {
          if (action.closeKind === "contributor_cap" && ctx.contributorCapCancelCi) {
            await recordCiCancelOutcome(env, "contributor_cap", ctx, ctx.headSha);
          } else if (action.closeKind === "blacklist") {
            await recordCiCancelOutcome(env, "blacklist", ctx, ctx.headSha);
          }
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
          // #6636: enrich the notification with the AI's actual gate-verdict reasoning (the latest recorded
          // gate_decision summary for this PR) instead of only the plain disposition reason — resolveDispositionReason
          // falls back to `action.reason` when no verdict is on record or the read fails, so this is byte-identical
          // when there's nothing to enrich with. review_audit keys gate_decision rows by `${repoFullName}#${number}`.
          const summary = await resolveDispositionReason(env, `${ctx.repoFullName}#${ctx.pullNumber}`, action.reason);
          const notifyParams = { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, outcome: notifyOutcome, summary, submitter: ctx.authorLogin };
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
        } else if (action.actionClass === "update_branch" && isMergeConflictMessage(errorMessage(error))) {
          // LOOPOVER-24: update_branch performs a real merge internally, so it fails with the same "merge
          // conflict" shape a MERGE action does -- but unlike a merge's terminal hold (a PR permanently blocked
          // until a human intervenes), this is NOT a stuck state: forceUpdateBranch's caller (prReadyForReview)
          // already falls through to reviewing the PR on its current, non-rebased head when this returns false
          // (see forceUpdateBranch's own doc comment), exactly like every other "couldn't rebase, review anyway"
          // path. The branch owner, not the bot, needs to resolve the conflict -- paging on every naturally-
          // diverged PR this happens to hit isn't warranted. Still recorded by the audit() call above.
        } else if (action.actionClass === "update_branch" && isWorkflowScopeRefusalMessage(errorMessage(error))) {
          // #9498: PERMANENT for this diff shape -- the App may not write .github/workflows/**, and update_branch
          // merges the base in, so any workflow change on the default branch since the fork makes the merge a
          // workflow write even when the PR touches none. Retrying cannot change the outcome (one PR was retried
          // nine times), so this is classified rather than paged, and the caller falls through to reviewing the
          // current head -- being un-rebasable is not a reason to stop reviewing.
        } else if (action.actionClass === "update_branch" && isNoNewBaseCommitsMessage(errorMessage(error))) {
          // LOOPOVER-24 (regressed shape): a 422 "There are no new commits on the base branch." means the head
          // was already up to date when update-branch fired -- the readiness check acted on a stale/cached
          // mergeable_state read. Nothing went wrong and nothing is stuck: the caller falls through to reviewing
          // the current head exactly as in the conflict case above. Audit-only; never a PostHog page.
        } else {
          // Non-merge action classes have no retry loop -- a single failure here is already this pass's terminal
          // outcome (the planner may re-attempt on the next sweep if the underlying condition clears itself), so
          // it is captured immediately rather than only on eventual exhaustion. Mirrors handleMergeFailure's own
          // terminal-hold capture below and the "a real failure the maintainer must see" convention already used
          // for review-pass failures (selfhost/posthog.ts's capturePostHogReviewFailure, queue/processors.ts).
          // Previously this class of failure was audit-log-only, invisible without a manual audit_events query.
          capturePostHogError(error, { kind: "agent_action_execution_failed", repo: ctx.repoFullName, pr: ctx.pullNumber, installationId: ctx.installationId, actionClass: action.actionClass }, "agent_action_execution_failed");
        }
        // #2265: a permission-looking 403 on a PR-write mutation can mean the LOCAL installations.permissions
        // snapshot is stale after a maintainer-initiated downgrade (GitHub sends no downgrade webhook). Rate-limit
        // 403s and operation-specific forbidden states are not permission evidence, and this refresh scans broad
        // installation state, so keep the hot error path narrowly filtered and per-installation cooled down.
        if (PR_WRITE_CLASSES.has(action.actionClass) && shouldRefreshInstallationHealthAfterPrWriteFailure(ctx.installationId, error)) {
          await refreshInstallationHealthForInstallation(env, ctx.installationId).catch(() => undefined);
        }
      }
    };
    // 8c) pre-merge contributor-cap re-check (#7284-fix / #9159, TOCTOU race): confirmed live -- a PR whose OWN
    // earlier cap check passed can still merge after a sibling's later cap-close made the author over cap,
    // because each PR's cap check runs independently with no shared lock. Re-verify right before the
    // irreversible write, under the SAME per-author mutex a concurrent sibling's cap-close/wake also acquires,
    // so the two can never both act on a stale view of the author's open-PR count. #9159: the mutex must span
    // the ACTUAL merge mutation (step 9) too, not just this re-check read -- releasing it beforehand (as this
    // used to) reopens the exact #7284 window the lock exists to close: a concurrent cap-close claims the
    // just-released lock, live-verifies this PR as still open, and wrong-closes it for a cap this merge was
    // about to relieve milliseconds later. `ctx.contributorCapMergeRecheck` is only ever set by the caller when
    // a cap is actually configured for this repo (the common case leaves it undefined) — zero added cost,
    // byte-identical to before this field existed.
    if (action.actionClass === "merge" && ctx.contributorCapMergeRecheck) {
      const authorLogin = ctx.authorLogin ?? "";
      const { acquired, ownerToken } = await claimContributorCapLock(env, ctx.repoFullName, authorLogin);
      if (!acquired) {
        // "denied", not a thrown error: the next natural re-evaluation (webhook/sweep) picks this PR back up
        // with fresh state once the concurrent holder finishes deciding for this same author.
        await audit("denied", `contributor cap lock contended for ${ctx.repoFullName} author ${authorLogin} — action not executed`);
        continue;
      }
      try {
        const stillUnderCap = await ctx.contributorCapMergeRecheck();
        if (!stillUnderCap) {
          await audit("denied", `contributor cap re-check confirmed ${authorLogin} is now over cap on ${ctx.repoFullName} — action not executed`);
          continue;
        }
        // #9159: the lock stays held across the merge mutation itself -- only released in the `finally` below,
        // AFTER performMutation has run to completion (success or failure) -- see this block's header comment.
        await performMutation();
      } finally {
        await releaseContributorCapLock(env, ctx.repoFullName, authorLogin, ownerToken);
      }
      continue;
    }
    // 9) live — perform the real mutation, recording success or the error.
    await performMutation();
  }

  await maybeEscalateModeration(env, { installationId: ctx.installationId, repoFullName: ctx.repoFullName, number: ctx.pullNumber, authorLogin: ctx.authorLogin, mode, moderationSettings: ctx.moderationSettings }, planned, outcomes);
  return outcomes;
}

const MODERATION_RULE_TYPES = new Set<string>(Object.keys(MODERATION_VIOLATION_EVENT_TYPE));

/** Pure text for the moderation-escalation follow-up comment (#mod-warning-context): the warning/banned LABEL
 *  alone doesn't tell a contributor (or a maintainer reading the closure later) how many violations are on
 *  record or how close they are to an automatic ban -- this always accompanies the label with the actual
 *  numbers. Exported for direct unit testing without driving the full escalation flow. `totalCount < banThreshold`
 *  is guaranteed by the `tier === "warning"` caller contract (moderationTierForViolationCount only returns
 *  "warning" below the threshold), so the remaining-count subtraction is never non-positive here. */
export function buildModerationEscalationComment(args: {
  tier: Exclude<ModerationTier, "none">;
  totalCount: number;
  banThreshold: number;
  violationDecayDays: number | null;
  blacklisted: boolean;
}): string {
  const decayNote =
    args.violationDecayDays !== null
      ? ` Violations older than ${args.violationDecayDays} day(s) no longer count toward this total.`
      : "";
  if (args.tier === "banned") {
    const blacklistNote = args.blacklisted
      ? " This contributor has been automatically added to the blacklist."
      : " Automatic blacklisting is not enabled for this instance, so no blacklist entry was added.";
    return `This contributor now has ${args.totalCount} recorded moderation violation(s), at or beyond the configured threshold of ${args.banThreshold}.${blacklistNote}${decayNote}`;
  }
  const remaining = args.banThreshold - args.totalCount;
  return `This contributor now has ${args.totalCount} recorded moderation violation(s) (warning threshold). ${remaining} more will result in an automatic ban.${decayNote}`;
}

/**
 * Moderation-rules engine (#selfhost-mod-engine / #review-evasion-protection): given that a moderation-
 * tracked enforcement action for `rule` ALREADY COMPLETED against `authorLogin` on `repoFullName#number`,
 * record the violation (idempotent), count the actor's currently-effective-rule violations, and apply the
 * warning/banned label + auto-blacklist -- the SAME escalation every anti-abuse mechanism in this codebase
 * shares. Extracted so the planner-driven path below (`maybeEscalateModeration`) and the direct webhook-
 * driven review-evasion enforcement handlers in `queue/processors.ts` -- which bypass the planner/executor
 * pipeline entirely, mirroring the existing draft-dodge/reopen-reclose direct-handler shape -- both reach the
 * SAME escalation behavior once their own enforcement close succeeds. Never throws: every write here is
 * best-effort, matching how the rest of this file treats CI-cancellation/notification side effects as
 * non-critical to the close itself. A no-op when the moderation layer (global or per-repo) does not
 * currently count `rule`.
 */
export async function applyModerationEscalationForRule(
  env: Env,
  args: { installationId: number; repoFullName: string; number: number; authorLogin: string; rule: ModerationRuleType; moderationSettings: ModerationContextSettings | null | undefined },
): Promise<void> {
  const globalConfig = await getGlobalModerationConfig(env);
  if (!resolveModerationGateEnabled(globalConfig.enabled, args.moderationSettings?.moderationGateMode ?? "inherit")) return;
  const effectiveRules = resolveEffectiveModerationRules(globalConfig.rules, args.moderationSettings?.moderationRules);
  if (!effectiveRules.includes(args.rule)) return;

  const targetKey = `${args.repoFullName}#${args.number}`;
  // #gate-flagged: idempotent per (actor, eventType, targetKey) -- a webhook redelivery or queue retry that
  // re-executes an ALREADY-recorded close is not a new violation, so skip the rest of escalation entirely
  // (re-labeling/re-checking the ban threshold off a stale "nothing new happened" pass is redundant, not just
  // harmless). A write failure fails OPEN (treated as "new"), matching this function's existing best-effort
  // philosophy elsewhere -- a lost write should not also silently suppress the escalation it was recording for.
  const isNewViolation = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE[args.rule], actor: args.authorLogin, targetKey, repoFullName: args.repoFullName, ruleReason: `${args.rule} violation` }).catch(() => true);
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

  let blacklisted = false;
  if (tier === "banned" && globalConfig.autoBlacklistOnBan) {
    /* v8 ignore next -- getGlobalContributorBlacklist never actually resolves undefined (it fails open to
       `[]`); the `?? []` only satisfies RepositorySettings["contributorBlacklist"]'s optional TS type. */
    const current = (await getGlobalContributorBlacklist(env)) ?? [];
    if (isAuthorBlacklisted(args.authorLogin, current)) {
      blacklisted = true;
    } else {
      const banReason = `moderation-engine auto-ban: ${totalCount} lifetime violations reached the configured threshold`;
      const nextBlacklist = [...current, { login: args.authorLogin, reason: banReason, evidence: [targetKey] }];
      // A write failure here must not throw (this whole function is best-effort, matching the label
      // application above) -- it degrades `blacklisted` to false so the escalation comment below correctly
      // says no blacklist entry was added, rather than claiming a ban that didn't actually happen.
      blacklisted = await upsertGlobalContributorBlacklist(env, { contributorBlacklist: nextBlacklist })
        .then(() => true)
        .catch(() => false);
    }
  }

  // #mod-warning-context: a maintainer (or the contributor) reading the closure later has no way to know how
  // many violations are on record or how close this contributor is to an automatic ban from the label alone --
  // post it as a plain follow-up comment (best-effort, matching every other side effect in this function)
  // rather than threading it back into the original close comment, which is already posted by the time
  // escalation runs.
  const escalationComment = buildModerationEscalationComment({
    tier,
    totalCount,
    banThreshold: globalConfig.banThreshold,
    violationDecayDays: globalConfig.violationDecayDays,
    blacklisted,
  });
  await createIssueComment(env, args.installationId, args.repoFullName, args.number, escalationComment).catch(() => undefined);
}

/**
 * Moderation-rules engine (#selfhost-mod-engine): a SINGLE convergence point for the three planner-staged
 * anti-abuse mechanisms (blacklist, contributor cap, review-nag) that already tag their `close` action with a
 * matching `closeKind` -- rather than duplicating this wiring at every one of their several call sites in
 * `queue/processors.ts`, this scans the JUST-EXECUTED plan for a moderation-tracked close that actually
 * COMPLETED (not denied/queued/dry-run -- an action that didn't really happen must not count as a violation)
 * and, if so, delegates to {@link applyModerationEscalationForRule}. A no-op in `dry_run`/`paused` mode (no
 * label/ban side effects for a mutation that didn't really happen).
 */
async function maybeEscalateModeration(
  env: Env,
  args: { installationId: number; repoFullName: string; number: number; authorLogin?: string | null | undefined; mode: AgentActionMode; moderationSettings: ModerationContextSettings | null | undefined },
  planned: PlannedAgentAction[],
  outcomes: AgentActionOutcome[],
): Promise<void> {
  if (!args.authorLogin || args.mode !== "live") return;
  const index = planned.findIndex((action, i) => action.actionClass === "close" && action.closeKind !== undefined && MODERATION_RULE_TYPES.has(action.closeKind) && outcomes[i]?.outcome === "completed");
  const closeKind = index === -1 ? undefined : planned[index]?.closeKind;
  if (closeKind === undefined) return;
  await applyModerationEscalationForRule(env, {
    installationId: args.installationId,
    repoFullName: args.repoFullName,
    number: args.number,
    authorLogin: args.authorLogin,
    rule: closeKind as ModerationRuleType,
    moderationSettings: args.moderationSettings,
  });
}

// CI-run cancellation on an anti-abuse close (#2462 contributor_cap, extended to blacklist #6659): the two
// closeKinds that share this behavior. contributor_cap keeps its original event-type spelling below (an
// existing Grafana/audit convention other tooling already queries by -- never renamed); blacklist gets its
// own parallel spelling rather than reusing contributor_cap's, so the audit trail never mislabels WHY a
// PR's CI was cancelled.
type CiCancelReasonKind = "contributor_cap" | "blacklist";

/** CI-run cancellation on an anti-abuse close: runs cancelInFlightWorkflowRunsForHeadSha and records exactly
 *  one of two audit outcomes, mirroring the established `github_app.*_permission_missing` convention
 *  (processors.ts's check-run/gate-check permission-missing audits) so a fleet-wide actions:write scope gap
 *  surfaces the same way those already do. Never throws -- both recordAuditEvent calls are best-effort
 *  (`.catch(() => undefined)`), since a failure to WRITE the audit record must not retroactively affect the
 *  close this already ran after. */
async function auditCiCancelled(
  env: Env,
  reasonKind: CiCancelReasonKind,
  targetKey: string,
  repoFullName: string,
  headSha: string,
  outcome: { cancelledCount: number; totalFound: number },
): Promise<void> {
  const detail = `cancelled ${outcome.cancelledCount} of ${outcome.totalFound} in-flight workflow run(s)`;
  const metadata = { repoFullName, headSha, cancelledCount: outcome.cancelledCount, totalFound: outcome.totalFound };
  const eventType = reasonKind === "blacklist" ? "github_app.blacklist_ci_cancelled" : "github_app.contributor_cap_ci_cancelled";
  const write = recordAuditEvent(env, { eventType, actor: AGENT_ACTOR, targetKey, outcome: "completed", detail, metadata });
  await write.catch(() => undefined);
}

// #gate finding: a genuine cancel error (network/create-token/list-run failure -- reason "error") is not a
// permission gap; recording it under the permission-missing event type mislabels it for anyone
// querying/dashboarding by eventType, even though metadata.reason already carries the real outcome.kind.
async function auditCiCancelFailed(env: Env, reasonKind: CiCancelReasonKind, targetKey: string, repoFullName: string, headSha: string, reason: string, warning: string): Promise<void> {
  const metadata = { repoFullName, headSha, reason };
  const prefix = reasonKind === "blacklist" ? "blacklist" : "contributor_cap";
  const eventType = reason === "permission_missing" ? `github_app.${prefix}_ci_cancel_permission_missing` : `github_app.${prefix}_ci_cancel_failed`;
  const write = recordAuditEvent(env, { eventType, actor: AGENT_ACTOR, targetKey, outcome: "error", detail: warning, metadata });
  await write.catch(() => undefined);
}

async function recordCiCancelOutcome(env: Env, reasonKind: CiCancelReasonKind, ctx: AgentActionExecutionContext, headSha: string): Promise<void> {
  const targetKey = `${ctx.repoFullName}#${ctx.pullNumber}`;
  const outcome = await cancelInFlightWorkflowRunsForHeadSha(env, ctx.installationId, ctx.repoFullName, headSha, ctx.pullNumber);
  if (outcome.kind === "cancelled") {
    await auditCiCancelled(env, reasonKind, targetKey, ctx.repoFullName, headSha, outcome);
    return;
  }
  // #9130: the instance-wide kill switch suppressed this call before any network request was even attempted --
  // never a failure worth a `_ci_cancel_failed` audit/error log, since nothing went wrong. Silent no-op, matching
  // how the outer loop already skips a whole action pass under dry_run/paused without a special per-side-effect
  // audit here.
  if (outcome.kind === "suppressed") return;
  console.error(
    JSON.stringify({
      level: "error",
      event: `${reasonKind}_ci_cancel_failed`,
      reason: outcome.kind,
      repository: ctx.repoFullName,
      pullNumber: ctx.pullNumber,
      message: outcome.warning,
    }),
  );
  await auditCiCancelFailed(env, reasonKind, targetKey, ctx.repoFullName, headSha, outcome.kind, outcome.warning);
}

export type IssueActionExecutionContext = {
  installationId: number;
  repoFullName: string;
  issueNumber: number;
  autonomy: AutonomyPolicy | null | undefined;
  agentPaused?: boolean | undefined;
  agentDryRun?: boolean | undefined;
  // Issue author login -- needed for the moderation-rules engine's violation ledger (#selfhost-mod-engine).
  // #9541: REQUIRED on the ISSUE path too. #9482 only audited the PR context, but this one carries the same
  // two fields with the same silent-omission hazard -- fixing one type and not its twin is exactly the drift
  // this deliverable exists to end.
  authorLogin: string | null;
  moderationSettings: ModerationContextSettings | null;
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
  const mode = resolveAgentActionMode({ globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)), instanceMode: forcedSelfhostMode(env), agentPaused: ctx.agentPaused, agentDryRun: ctx.agentDryRun });

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
      const boundedDetail = boundAuditReason(detail);
      outcomes.push({ actionClass: action.actionClass, outcome, detail: boundedDetail });
      return recordAuditEvent(
        env,
        buildAgentActionAudit({ actionClass: action.actionClass, autonomyLevel, mode, outcome: auditOutcome, repoFullName: ctx.repoFullName, targetKey, actor: AGENT_ACTOR, reason: boundedDetail, ...closeReasonsForAudit(action) }),
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
      // Mirrors executeAgentMaintenanceActions's non-merge capture below -- issue-side label/close has no retry
      // loop either, so a single failure here is already this pass's terminal outcome.
      capturePostHogError(error, { kind: "agent_issue_action_execution_failed", repo: ctx.repoFullName, issue: ctx.issueNumber, installationId: ctx.installationId, actionClass: action.actionClass }, "agent_issue_action_execution_failed");
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
  const { terminal: classifiedTerminal, reason: classifiedReason, scope } = classifyMergeFailure(error);
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
  // #9012: an infra-scoped cause (rejected token, exhausted rate-limit window) is fleet-wide and self-healing,
  // so its block expires and is re-probed; a commit-scoped one still lasts until the contributor pushes. The
  // scope carries through the retry-cap path above deliberately — a sustained secondary-rate-limit window is
  // exactly the case that used to burn MERGE_RETRY_CAP and then permanently strand every PR it caught.
  const expiresAt = scope === "infra" ? new Date(Date.now() + INFRA_MERGE_BLOCK_TTL_MS).toISOString() : undefined;
  await markPullRequestMergeBlocked(env, ctx.repoFullName, ctx.pullNumber, headSha, reason, expiresAt);
  // A merge held for a human is the terminal outcome of this whole retry sequence -- exactly the "a real
  // failure the maintainer must see" case capturePostHogReviewFailure already covers for an exhausted AI
  // review pass. Fires once per hold (not per retry attempt), so a transient failure that resolves within
  // MERGE_RETRY_CAP never reaches PostHog at all.
  // Named "agent_merge_blocked" (not the caught exception's own class, e.g. "HttpError") so every terminal
  // merge hold groups under one readable title regardless of which HTTP status caused it -- the specific
  // status/reason stays in the message and the "review" context object either way.
  capturePostHogError(error, { kind: "agent_merge_blocked", repo: ctx.repoFullName, pr: ctx.pullNumber, installationId: ctx.installationId, reason: reason.slice(0, 280) }, "agent_merge_blocked");
  await recordAuditEvent(env, {
    eventType: "agent.action.merge_blocked",
    actor: AGENT_ACTOR,
    targetKey: `${ctx.repoFullName}#${ctx.pullNumber}`,
    outcome: "denied",
    detail: `merge held for human — ${reason}`,
    metadata: { repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, headSha, reason: reason.slice(0, 280), scope, ...(expiresAt !== undefined ? { expiresAt } : {}) },
  }).catch(() => undefined);
}

/** Performs the action's real GitHub mutation. Returns an optional audit-detail override — used only by the
 *  "assign" case (below) to distinguish a real assignee from the by:<login> fallback, since GitHub silently
 *  drops an ineligible assignee rather than erroring, so the caller's generic `audit("completed", action.reason)`
 *  would otherwise look identical for both outcomes. Every other case implicitly returns undefined, keeping the
 *  caller's original `action.reason` detail. */
async function performAction(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction): Promise<string | undefined> {
  switch (action.actionClass) {
    case "label":
      // Flag-then-close double-check: a `label` action may ADD (default) or REMOVE its label, and may carry an
      // optional comment (the Pass-1 flag warning, or the resolved note) posted alongside the label mutation.
      if (action.labelOp === "remove") {
        await removePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "");
        // #9939: the label is gone, so its provenance must go with it. Leaving a stale marker behind would let
        // a LATER human-applied label inherit the bot's provenance and become auto-removable -- exactly the
        // override the provenance exists to prevent. Best-effort: a failed clear only means the next pass
        // re-evaluates with a marker for a label that is not there, which the `hasLabel` guard already ignores.
        if (ctx.manualReviewLabel && action.label === ctx.manualReviewLabel) {
          await clearPullRequestManualReviewLabelProvenance(env, ctx.repoFullName, ctx.pullNumber).catch(() => {});
        }
      } else {
        await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.label ?? "", { createMissingLabel: true });
        // #9939: record that the PLANNER (not a maintainer) applied this hold, so a later pass may lift it
        // once nothing wants it. Written only here, on the bot's own add, which is what keeps a
        // human-applied label provenance-free and therefore untouchable.
        if (ctx.manualReviewLabel && action.label === ctx.manualReviewLabel && ctx.headSha) {
          await markPullRequestManualReviewLabelApplied(env, ctx.repoFullName, ctx.pullNumber, ctx.headSha, action.reason).catch(() => {});
        }
      }
      if (action.comment) await createIssueComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.comment);
      return;
    case "request_changes":
      await createPullRequestReview(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "REQUEST_CHANGES", action.reviewBody ?? "");
      return;
    case "approve": {
      if (action.dismissStaleApproval) {
        await dismissLatestBotApproval(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, "LoopOver retracted this approval — a newer commit no longer qualifies.");
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
      const mergeResult = await mergePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, { mergeMethod: action.mergeMethod ?? "squash", ...(mergeSha ? { sha: mergeSha } : {}) });
      // #9130: a suppressed merge (the instance-wide kill switch fired) is a SYNTHETIC shadow response, not a
      // real GitHub mutation -- structurally unreachable via the normal call path (the loop above already
      // gates on `mode` before ever reaching performAction under dry_run/paused), but defense in depth for any
      // future caller that bypasses that gate. Never record it as ground truth: a real later outcome must still
      // be able to write this row, which recordTerminalActionOutcome's own first-write-wins probe would
      // otherwise permanently block.
      if (mergeResult.suppressed) return "merge suppressed by the instance-wide dry-run/paused kill switch — no GitHub write attempted";
      // #8823: record ground truth from the action we just completed rather than depending on the inbound
      // `pull_request.closed` webhook — a delivery this instance never processes used to lose the outcome
      // permanently, dropping the PR out of fleet calibration entirely. Idempotent against the webhook path.
      await recordTerminalActionOutcome(env, ctx.repoFullName, ctx.pullNumber, "merged");
      return;
    }
    case "close":
      // #8803: marker-idempotent — when the comment lands but the close call fails transiently, the retry's
      // replan produces the identical closeComment; the marker helper skips/PATCHes the canonical comment
      // instead of stacking a duplicate "why we closed you" every failed cycle.
      if (action.closeComment) await createOrUpdateCloseExplanationComment(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, action.closeComment, action.closeKind);
      await closePullRequest(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber);
      // #8823: see the merge case — the bot's own close is authoritative ground truth and must not depend on
      // a webhook round-trip the instance might never see.
      await recordTerminalActionOutcome(env, ctx.repoFullName, ctx.pullNumber, "closed");
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
    case "assign": {
      const login = action.assignee ?? "";
      if (!login) return undefined;
      const result = await ensurePullRequestAssignee(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, login);
      if (!result.applied) {
        // GitHub silently drops an assignee lacking push/triage access to the repo -- the common case for an
        // external contributor. Fall back to a per-login label instead of a comment: ensurePullRequestLabel's
        // own GET dedup makes this idempotent, so a repeated sweep never re-posts/spams once the label exists.
        // Prefix kept short ("by:", not "contributor:") -- GitHub logins run up to 39 chars and label names cap
        // at 50, so a longer prefix can push a valid max-length login past the limit and fail this fallback for
        // exactly the contributors it exists to cover.
        await ensurePullRequestLabel(env, ctx.installationId, ctx.repoFullName, ctx.pullNumber, `by:${login}`, { createMissingLabel: true });
        // Audit-visibility gap fix: without this override, "completed" always carries the planner's generic
        // "auto-assign PR opener" reason, so audit_events can't distinguish a real assignee from this fallback.
        return `assignee refused by GitHub — fell back to a by:${login} label`;
      }
      return undefined;
    }
  }
}

/** The execute-time payload of a planned action, persisted so the approval queue (#779) can run it on accept. */
export function actionParams(action: PlannedAgentAction): AgentPendingActionParams {
  return {
    ...(action.autonomyClass !== undefined ? { autonomyClass: action.autonomyClass } : {}),
    ...(action.label !== undefined ? { label: action.label } : {}),
    ...(action.labelOp !== undefined ? { labelOp: action.labelOp } : {}),
    ...(action.comment !== undefined ? { comment: action.comment } : {}),
    ...(action.reviewBody !== undefined ? { reviewBody: action.reviewBody } : {}),
    ...(action.mergeMethod !== undefined ? { mergeMethod: action.mergeMethod } : {}),
    ...(action.assignee !== undefined ? { assignee: action.assignee } : {}),
    ...(action.closeComment !== undefined ? { closeComment: action.closeComment } : {}),
    ...(action.closeReasons !== undefined ? { closeReasons: [...boundStructuredCloseReasonsForPersistence(action.closeReasons)] } : {}),
    ...(action.expectedHeadSha !== undefined ? { expectedHeadSha: action.expectedHeadSha } : {}),
    ...(action.dismissStaleApproval !== undefined ? { dismissStaleApproval: action.dismissStaleApproval } : {}),
    // Round-trip closeKind so a staged close's kind survives to accept-time — without it, the close-precision
    // breaker's isHeuristicClose check (which matches on closeKind === "heuristic") could never fire for any
    // staged close, silently defeating the breaker for the entire approval-queue accept path (#2127).
    ...(action.closeKind !== undefined ? { closeKind: action.closeKind } : {}),
    // Round-trip the CI dependency separately from closeKind: closeKind is intentionally broad (gate-verdict /
    // duplicate / slop / CI) for the close-precision breaker, but only red-CI closes need the live-CI guard.
    ...(action.closeRequiresCiState !== undefined ? { closeRequiresCiState: action.closeRequiresCiState } : {}),
    // Round-trip the mergeable-state dependency likewise: only a conflict-justified close needs the approval
    // queue's accept-time mergeable-state recheck (see the field's doc comment on AgentPendingActionParams).
    ...(action.closeRequiresMergeableState !== undefined ? { closeRequiresMergeableState: action.closeRequiresMergeableState } : {}),
    // Round-trip the review-thread dependency likewise: only a thread-justified close needs the accept-time /
    // pre-mutation live thread-blocker recheck (see the field's doc comment on AgentPendingActionParams).
    ...(action.closeRequiresThreadResolved !== undefined ? { closeRequiresThreadResolved: action.closeRequiresThreadResolved } : {}),
    // Round-trip the duplicate-PR dependency likewise: only a duplicate-justified close needs the live
    // duplicate-still-open recheck (#dup-winner-staleness, see the field's doc comment on AgentPendingActionParams).
    ...(action.closeRequiresDuplicateStillOpen !== undefined ? { closeRequiresDuplicateStillOpen: action.closeRequiresDuplicateStillOpen } : {}),
    // Round-trip the named winning sibling so the recheck re-verifies THAT PR specifically on replay too.
    ...(action.duplicateWinnerPrNumber !== undefined ? { duplicateWinnerPrNumber: action.duplicateWinnerPrNumber } : {}),
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
/** Returns whether a row was actually staged (a fresh one, or an expired one reopened per #9481) -- the
 *  caller only audits "awaiting maintainer approval" when a notification genuinely went out. */
async function stageForApproval(env: Env, ctx: AgentActionExecutionContext, action: PlannedAgentAction, autonomyLevel: AutonomyLevel): Promise<boolean> {
  const { created } = await createPendingAgentActionIfAbsent(env, {
    repoFullName: ctx.repoFullName,
    pullNumber: ctx.pullNumber,
    installationId: ctx.installationId,
    actionClass: action.actionClass,
    autonomyLevel,
    params: actionParams(action),
    reason: action.reason,
  });
  if (!created) return false;
  /* v8 ignore next -- a repo full name always has an owner segment; the empty fallback is purely defensive. */
  const recipientLogin = ctx.repoFullName.split("/")[0] ?? "";
  const { created: deliveryCreated, delivery } = await insertNotificationDeliveryIfAbsent(env, {
    dedupKey: `agent.pending_action:${ctx.repoFullName}#${ctx.pullNumber}:${action.actionClass}`,
    channel: "badge",
    recipientLogin,
    eventType: "agent.pending_action",
    repoFullName: ctx.repoFullName,
    pullNumber: ctx.pullNumber,
    title: `LoopOver staged a ${action.actionClass.replace(/_/g, " ")} for your approval`,
    body: `${action.reason}. Accept to execute it, or reject to cancel.`,
    deeplink: `https://github.com/${ctx.repoFullName}/pull/${ctx.pullNumber}`,
    actorLogin: AGENT_ACTOR,
  });
  // #10025: enqueue the notify-deliver job that promotes this pending row to delivered — without it the badge
  // sits invisible in notification_deliveries until the stranded-delivery sweep rescues it 10+ minutes later.
  // Mirrors evaluateAndEnqueueNotificationDeliveries' `created && status === "pending"` guard: a dedup hit
  // (already sent) or a rate-limit-suppressed non-pending row enqueues nothing. Best-effort: a failed send
  // must not abort staging (still returns true), only log.
  // The `status === "pending"` arm mirrors evaluateAndEnqueueNotificationDeliveries' guard and honours the
  // "send nothing for a suppressed row" contract, but this insert never passes a status, so the delivery is
  // always pending here -- the false arm is unreachable from THIS caller (rate-limit suppression lives in
  // evaluateNotificationEvent, a different helper), hence the ignore. `created` false IS reachable (a dedup).
  /* v8 ignore next -- `delivery.status === "pending"` is always true from this caller; the guard is the shared contract */
  if (deliveryCreated && delivery.status === "pending") {
    await env.JOBS.send({ type: "notify-deliver", requestedBy: "agent-approval", deliveryId: delivery.id }).catch((error: unknown) => {
      console.warn(JSON.stringify({ event: "approval_notification_enqueue_failed", deliveryId: delivery.id, repoFullName: ctx.repoFullName, pullNumber: ctx.pullNumber, message: errorMessage(error).slice(0, 200) }));
    });
  }
  return true;
}
