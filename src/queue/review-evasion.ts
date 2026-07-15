// Review-evasion / close-enforcement guards (#4013 step 5 -- extracted from processors.ts, fifth step of
// the file's own module-split sequence, after transient-locks.ts, signal-snapshot.ts,
// duplicate-detection.ts, and slop-detection.ts). Pure move; only the 5 top-level "maybe*" entry points are
// exported (each called from exactly one webhook-handler call site still in processors.ts) -- every other
// function/type/constant here (withPrActuationLock, evaluateCloseEnforcementGate, hasMaintainerOrOwnerPermission,
// the "close*If*" implementations, ReopenRecloseOutcome, REVIEW_EVASION_CLOSED_EVENT_TYPE) is private to this
// file, since none of them had any caller outside this cluster in the original file either.

import {
  getGateBlockOutcome,
  getInstallation,
  hasReviewedForHeadSha,
  isGlobalAgentFrozen,
  recordAuditEvent,
  terminalizeActiveReviewTracking,
} from "../db/repositories";
import { getRepositoryCollaboratorPermission } from "../github/app";
import { ensurePullRequestLabel } from "../github/labels";
import { fetchPullRequestFreshness, pullRequestFreshnessDetail, type PullRequestFreshness } from "../github/pr-freshness";
import { closePullRequest, createIssueComment, getLastCloserLogin, getLastReopenerLogin, reopenPullRequest } from "../github/pr-actions";
import { parseGitHubLoginList } from "../auth/security";
import { isAutoCloseExempt } from "../settings/auto-close-exempt";
import { resolveAutonomy } from "../settings/autonomy";
import { isGlobalAgentPause, resolveAgentActionMode, resolveAgentPermissionReadiness } from "../settings/agent-execution";
import { DEFAULT_REVIEW_EVASION_LABEL, isProtectedAutomationAuthor, resolveNullableLabel } from "../settings/agent-actions";
import { applyModerationEscalationForRule } from "../services/agent-action-executor";
import { resolveRepositorySettings } from "../settings/repository-settings";
import { claimPrActuationLock, PrActuationLockContendedError, releasePrActuationLock } from "./transient-locks";
import { errorMessage } from "../utils/json";
import type { GitHubWebhookPayload, JsonValue, PullRequestRecord, RepositorySettings } from "../types";

/** Claims the per-PR actuation lock, runs `action`, and always releases it -- the byte-identical
 *  claim/try/finally-release wrapper every one of the 5 close-enforcement guards below used to duplicate
 *  (only the `policy` label and the wrapped callee differed). Lock contention is retryable (#2135/#2447): a
 *  concurrent delivery for the same PR must not evaluate + potentially mutate it at the same time, but
 *  ordinary maintenance holding the shared lock without enforcing one of these events is expected, so
 *  contention throws a `RetryableJobError` rather than failing the job outright. */
async function withPrActuationLock<T>(
  env: Env,
  repoFullName: string,
  prNumber: number,
  policy: string,
  action: () => Promise<T>,
): Promise<T> {
  const actuationLock = await claimPrActuationLock(env, repoFullName, prNumber);
  if (!actuationLock.acquired) {
    throw new PrActuationLockContendedError(repoFullName, prNumber, policy);
  }
  try {
    return await action();
  } finally {
    await releasePrActuationLock(env, repoFullName, prNumber, actuationLock.ownerToken);
  }
}

/** Result of {@link evaluateCloseEnforcementGate}: `proceed: true` means the caller's own domain-specific
 *  freshness re-check(s) and mutation may continue; `proceed: false` means the gate already recorded
 *  whatever audit event applies (or, for a `stood_down` paused/frozen repo with no configured `paused`
 *  text, recorded nothing at all -- see the draft-dodge call site) and the caller must stop. `reason`
 *  distinguishes WHY only where a caller's own return value depends on it (today, only the reopen-reclose
 *  guard: an autonomy denial maps to its "allowed" outcome, every other denial maps to "reclosed"/handled). */
type CloseEnforcementGateResult =
  | { proceed: true }
  | { proceed: false; reason: "autonomy_denied" | "stood_down" | "permission_not_ready" | "stale" };

/** Shared (a)-(c) scaffolding for the 5 close-enforcement guards below (#4602 fast-follow on #4637): resolves
 *  the agent action mode (global kill-switch / per-repo freeze / dry-run), enforces the close-autonomy gate
 *  each guard bypasses `executeAgentMaintenanceActions`'s standard pipeline for, stands down on a non-live
 *  mode, optionally re-checks write-permission readiness, and re-checks live PR freshness immediately before
 *  a caller's mutation -- exactly the sequence #4637 fixed the first 2 of these 5 paths to include. Every
 *  audit event this gate itself records uses the caller-supplied `eventType`/`targetKey`/detail/metadata
 *  EXACTLY as the caller's own pre-extraction code built them, so behavior for all 5 callers is unchanged;
 *  the actual GitHub mutation and its post-success side effects (comment/label/moderation) always stay in
 *  the caller, since those differ too much between guards to unify (self-close's reopen-then-close with
 *  asymmetric error handling vs. the other 4's single close call).
 *
 *  `permissionReadiness: null` skips the write-permission-readiness step entirely -- the reopen-reclose
 *  guard has never had this check (a pre-existing gap distinct from #4602/#4637's close-autonomy gap; not
 *  introduced or fixed by this extraction, since a refactor must not change behavior).
 *  `paused: null` records NO audit event on a paused/frozen repo -- draft-dodge's existing, preserved gap
 *  (every other guard here DOES audit a paused stand-down; draft-dodge simply never has). */
async function evaluateCloseEnforcementGate(args: {
  env: Env;
  installationId: number;
  repoFullName: string;
  pr: PullRequestRecord;
  settings: RepositorySettings;
  eventType: string;
  targetKey: string;
  // Formatted into the close-autonomy-denied detail as `... not enforced for ${actor}` -- every one of the
  // 5 callers' own autonomy-denied text follows this exact template, differing only in `actionLabel`/`actor`.
  actionLabel: string;
  actor: string;
  // Merged into the close-autonomy-denied audit event verbatim (already includes deliveryId/repoFullName).
  metadata: Record<string, JsonValue>;
  dryRun: { detail: string; metadata: Record<string, JsonValue> };
  paused: { detail: string; metadata: Record<string, JsonValue> } | null;
  permissionReadiness: { detail: string; metadata: Record<string, JsonValue> } | null;
  freshness: {
    requireDraft?: boolean;
    // Appended directly after `pullRequestFreshnessDetail(freshness)` -- callers keep their own exact
    // separator/wording (some use " — ...", some use " -- ...").
    detailSuffix: string;
    metadata: Record<string, JsonValue>;
    // Self-close's escape hatch: a "closed" freshness result is EXPECTED there (this handler's own
    // trigger IS the self-close webhook) as long as the live head still matches. Every other caller
    // omits this and gets the plain status==="current" check.
    allowStaleIf?: (freshness: PullRequestFreshness) => boolean;
  };
}): Promise<CloseEnforcementGateResult> {
  const { env, installationId, repoFullName, pr, settings, eventType, targetKey } = args;
  const mode = resolveAgentActionMode({
    globalPaused: isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env)),
    agentPaused: settings.agentPaused,
    agentDryRun: settings.agentDryRun,
  });
  const closeAutonomy = resolveAutonomy(settings.autonomy, "close");
  if (closeAutonomy !== "auto") {
    await recordAuditEvent(env, {
      eventType,
      actor: "loopover",
      targetKey,
      outcome: "denied",
      detail:
        closeAutonomy === "auto_with_approval"
          ? `close autonomy requires approval -- ${args.actionLabel} not enforced for ${args.actor}`
          : `autonomy for close is not acting -- ${args.actionLabel} not enforced for ${args.actor}`,
      metadata: args.metadata,
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return { proceed: false, reason: "autonomy_denied" };
  }
  if (mode === "dry_run") {
    await recordAuditEvent(env, {
      eventType,
      actor: "loopover",
      targetKey,
      outcome: "completed",
      detail: args.dryRun.detail,
      metadata: args.dryRun.metadata,
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return { proceed: false, reason: "stood_down" };
  }
  if (mode !== "live") {
    if (args.paused) {
      await recordAuditEvent(env, {
        eventType,
        actor: "loopover",
        targetKey,
        outcome: "denied",
        detail: args.paused.detail,
        metadata: args.paused.metadata,
      }).catch(
        /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
        () => undefined,
      );
    }
    return { proceed: false, reason: "stood_down" };
  }
  if (args.permissionReadiness) {
    const installation = await getInstallation(env, installationId);
    const installationPermissions = installation?.permissions ?? null;
    const readiness = resolveAgentPermissionReadiness({ autonomy: settings.autonomy, installationPermissions, actionClass: "close" });
    if (readiness !== "ready") {
      await recordAuditEvent(env, {
        eventType,
        actor: "loopover",
        targetKey,
        outcome: "denied",
        detail: args.permissionReadiness.detail,
        metadata: args.permissionReadiness.metadata,
      }).catch(
        /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
        () => undefined,
      );
      return { proceed: false, reason: "permission_not_ready" };
    }
  }
  const freshness = await fetchPullRequestFreshness(env, {
    installationId,
    repoFullName,
    pullNumber: pr.number,
    expectedHeadSha: pr.headSha,
    ...(args.freshness.requireDraft !== undefined ? { requireDraft: args.freshness.requireDraft } : {}),
  });
  const stale = freshness.status !== "current" && !(args.freshness.allowStaleIf?.(freshness) ?? false);
  if (stale) {
    await recordAuditEvent(env, {
      eventType,
      actor: "loopover",
      targetKey,
      outcome: "denied",
      detail: `${pullRequestFreshnessDetail(freshness)}${args.freshness.detailSuffix}`,
      metadata: args.freshness.metadata,
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler */
      () => undefined,
    );
    return { proceed: false, reason: "stale" };
  }
  return { proceed: true };
}

/** Draft-dodge guard (#converted-to-draft): a contributor converting an OPEN PR to draft cannot use draft state
 *  to keep a gate-rejected PR alive. When a prior gate failure exists for the PR's current headSha (and the
 *  block has not been maintainer-overridden), close the PR immediately — the gate verdict stands and does not
 *  reset on draft conversion. Per-PR actuation-locked (#2135/#2447): a concurrent delivery for the same PR must
 *  not evaluate + potentially mutate it at the same time. Lock contention is retryable because ordinary
 *  maintenance can hold the shared lock without enforcing this converted_to_draft event. */
export async function maybeCloseDraftDodgeAttempt(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<void> {
  await withPrActuationLock(env, repoFullName, pr.number, "draft-dodge", () =>
    closeDraftDodgeAttemptIfBlocked(env, deliveryId, installationId, repoFullName, pr, settings),
  );
}

async function closeDraftDodgeAttemptIfBlocked(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  settings: RepositorySettings,
): Promise<void> {
  const block = await getGateBlockOutcome(
    env,
    repoFullName,
    pr.number,
  ).catch(() => undefined);
  const repoOwner = repoFullName.includes("/")
    ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase()
    : "";
  const draftDodgeAuthorLogin = (pr.authorLogin ?? "").toLowerCase();
  const authorIsOwner =
    draftDodgeAuthorLogin === repoOwner && repoOwner.length > 0;
  // Fleet-operator identity (#2133): same ADMIN_GITHUB_LOGINS exemption as the primary close-eligibility
  // computation elsewhere — an admin login must never be auto-closed here either, matching every other
  // actuation path's trusted-operator definition.
  const authorIsAdmin =
    draftDodgeAuthorLogin.length > 0 &&
    parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(draftDodgeAuthorLogin);
  if (
    block &&
    block.headSha === pr.headSha &&
    !block.overridden &&
    !authorIsOwner &&
    !authorIsAdmin
  ) {
    /* v8 ignore next -- a deleted-account PR yields a null author login; the fallback is defensive */
    const draftDodgeAuthor = pr.authorLogin ?? "unknown";
    const targetKey = `${repoFullName}#${pr.number}`;
    const gateMetadata = { deliveryId, repoFullName, headSha: pr.headSha, blockerCodes: block.blockerCodes };
    const gate = await evaluateCloseEnforcementGate({
      env,
      installationId,
      repoFullName,
      pr,
      settings,
      eventType: "github_app.draft_dodge_closed",
      targetKey,
      actionLabel: "draft-dodge close",
      actor: draftDodgeAuthor,
      metadata: gateMetadata,
      dryRun: {
        detail: `dry-run: would close draft-dodge attempt by ${draftDodgeAuthor} — prior gate failure on headSha ${pr.headSha} stands`,
        metadata: { ...gateMetadata, mode: "dry_run" },
      },
      // Draft-dodge is the one guard of the 5 that records NO audit event on a paused/frozen repo -- a
      // pre-existing gap this extraction preserves rather than fixes (a refactor must not change behavior).
      paused: null,
      permissionReadiness: {
        detail: `denied draft-dodge close for ${draftDodgeAuthor} — pull_requests: write not granted`,
        metadata: gateMetadata,
      },
      freshness: {
        // requireDraft: head/state alone would still read "current" if the author converted the PR BACK
        // to ready_for_review in that window -- the draft-dodge close's own justification no longer
        // holds, since there is no longer a draft to be "dodging" the gate through.
        requireDraft: true,
        detailSuffix: " — draft-dodge close not executed",
        metadata: gateMetadata,
      },
    });
    if (!gate.proceed) return;

    const codes = block.blockerCodes.join(", ");
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      `Gate verdict stands for this commit — converting to draft does not reset the review. Re-submit a new PR with the issues addressed${codes ? ` (${codes})` : ""}.`,
    ).catch(() => undefined);
    await closePullRequest(
      env,
      installationId,
      repoFullName,
      pr.number,
    ).catch(() => undefined);
    await recordAuditEvent(env, {
      eventType: "github_app.draft_dodge_closed",
      actor: "loopover",
      targetKey,
      outcome: "completed",
      detail: `closed draft-dodge attempt by ${pr.authorLogin ?? "unknown"} — prior gate failure on headSha ${pr.headSha} stands`,
      metadata: gateMetadata,
    }).catch(() => undefined);
  }
}

/** Outcome of {@link maybeRecloseDisallowedReopen}: "reclosed" means the caller must skip the normal re-review
 *  pass; a plain boolean can't distinguish "evaluated, not blocked" from "reclosed, stop here". */
export type ReopenRecloseOutcome = "reclosed" | "allowed";

/** Reopen-prevention (#one-shot-reopen): re-close a contributor's reopen of a PR that loopover / a maintainer
 *  closed (closes are one-shot). Returns "reclosed" when it re-closed (caller skips the re-review). Exempt: the
 *  bot's own re-review reopens, owner/admin reopens, and a contributor reopening a PR they CLOSED THEMSELVES.
 *  Per-PR actuation-locked (#2135/#2447): a concurrent delivery for the same PR must not evaluate + potentially
 *  mutate this PR at the same time. Lock contention is retryable because ordinary maintenance can hold the
 *  shared lock without enforcing this reopened event. */
export async function maybeRecloseDisallowedReopen(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
): Promise<ReopenRecloseOutcome> {
  const reclosed = await withPrActuationLock(env, repoFullName, pr.number, "reopen-reclose", () =>
    recloseDisallowedReopenIfNeeded(env, deliveryId, installationId, repoFullName, pr, payload),
  );
  return reclosed ? "reclosed" : "allowed";
}

async function recloseDisallowedReopenIfNeeded(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
): Promise<boolean> {
  const reopener = (payload.sender?.login ?? "").toLowerCase();
  if (!reopener) return false;
  const botLogin = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
  if (reopener === botLogin) return false; // the bot's own nightly re-review reopen is allowed
  // The ": \"\"" fallback is unreachable via the real webhook path: repoFullName is always the
  // "owner/repo"-formatted payload.repository.full_name, and the surrounding pipeline already requires a
  // repository match on that exact format before any review-evasion handler runs (mirrors
  // hasMaintainerOrOwnerPermission's identical fallback below).
  /* v8 ignore next */
  const repoOwner = repoFullName.includes("/")
    ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase()
    : "";
  const admins = parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS); // unified parse: whitespace OR comma (#audit-3.13)
  const hasMaintainerPermission = async (login: string): Promise<boolean> => {
    if (login === repoOwner || admins.has(login)) return true;
    const permission = await getRepositoryCollaboratorPermission(
      env,
      installationId,
      repoFullName,
      login,
    ).catch(() => null);
    return (
      permission === "admin" ||
      permission === "maintain" ||
      permission === "write"
    );
  };
  if (await hasMaintainerPermission(reopener)) return false; // owner / admin / write collaborators may reopen
  // A non-maintainer reopened: re-close ONLY if loopover or a maintainer closed it (one-shot). A contributor
  // reopening a PR they closed themselves is allowed (fail-open on an unknown closer).
  const closerResult = await getLastCloserLogin(
    env,
    installationId,
    repoFullName,
    pr.number,
  );
  const closer = closerResult.login?.toLowerCase() ?? null;
  const closerIsBotOrMaintainer =
    closer != null &&
    (closer === botLogin || (await hasMaintainerPermission(closer)));
  // #audit-2.4: getLastCloserLogin inspects only a bounded newest-events window, so a contributor who appends
  // >1000 timeline events can push the real close out of view → null closer → bypass. When we could NOT inspect
  // the whole timeline AND found no qualifying closer, fail CLOSED — a one-shot close stands. A genuine
  // self-close sits at the timeline end and is found in-window, so legitimate self-close reopens stay allowed.
  const windowEvasionSuspected =
    closer == null && !closerResult.coveredAllPages;
  if (!closerIsBotOrMaintainer && !windowEvasionSuspected) return false;
  // Respect the agent action mode like every other write action (#killswitch-gap): a paused/frozen repo must
  // NOT touch GitHub, and dry-run records the would-be re-close without acting — so a dry-run is truly inert and
  // the global kill-switch is a COMPLETE stop. This close path previously bypassed pause/freeze/dry-run entirely.
  const reopenSettings = await resolveRepositorySettings(env, repoFullName);
  const targetKey = `${repoFullName}#${pr.number}`;
  const gateMetadata = { deliveryId, repoFullName };
  // Close-autonomy gate (#4602): isAgentConfigured alone is too loose here -- it is true whenever ANY autonomy
  // class is acting (e.g. merge: "auto"), not specifically close, so a repo that opts into some OTHER
  // autonomy class while deliberately leaving close unconfigured (deny-by-default) could still have a
  // disallowed reopen re-closed here. Mirrors the review-evasion siblings' identical gate; the shared gate
  // below checks the close action class directly rather than isAgentConfigured, so a repo that never
  // authorized close specifically can't have its disallowed reopen re-closed here (#review-audit). Unlike the
  // other 4 close-enforcement guards, this one has never had a write-permission-readiness check
  // (`permissionReadiness: null` below preserves that pre-existing gap, distinct from #4602's autonomy gap).
  const gate = await evaluateCloseEnforcementGate({
    env,
    installationId,
    repoFullName,
    pr,
    settings: reopenSettings,
    eventType: "github_app.reopen_reclosed",
    targetKey,
    actionLabel: "reopen re-close",
    actor: reopener,
    metadata: gateMetadata,
    dryRun: {
      detail: `dry-run: would re-close a disallowed reopen by ${reopener}`,
      metadata: { ...gateMetadata, mode: "dry_run" },
    },
    paused: {
      detail: `skipped (agent paused): would re-close a disallowed reopen by ${reopener}`,
      metadata: { ...gateMetadata, mode: "paused" },
    },
    permissionReadiness: null,
    freshness: {
      detailSuffix: " — reopen re-close not executed",
      metadata: gateMetadata,
    },
  });
  if (!gate.proceed) return gate.reason !== "autonomy_denied"; // handled (decision made) unless autonomy denied
  // Head/state freshness alone can't see a permission grant: the SAME reopener could be promoted to a
  // maintainer/admin/write collaborator (or added as one) in the window since the check above ran, which
  // would authorize exactly the reopen this handler is about to undo. Re-verify immediately before the
  // mutation, not just once at ingestion time.
  if (await hasMaintainerPermission(reopener)) {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "loopover",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: `${reopener} now holds maintainer permission — reopen re-close not executed`,
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    return true; // handled (decision made); a newly-authorized reopener still counts as handled
  }
  // Live re-check #3 (#2369): head/state freshness and the reopener's OWN permission are not the only things that
  // can move in the window before this fires — a DIFFERENT person (e.g. an actual maintainer) can reopen the SAME
  // PR again after the original disallowed reopen, which is a legitimate, authorized reopen. Since the PR was
  // already open, that second reopen doesn't change head/state, so checks #1/#2 above cannot see it. Ask directly:
  // is `reopener` STILL the most recent "reopened" actor on this PR's timeline? If someone else's reopen is now the
  // live reason the PR is open, re-closing it would wrongly undo that person's authorized action.
  const latestReopener = await getLastReopenerLogin(
    env,
    installationId,
    repoFullName,
    pr.number,
  );
  const latestReopenerLogin = latestReopener.login?.toLowerCase() ?? null;
  // A bounded scan that did NOT cover every page and found no reopened event is attacker-controllable: padding can
  // hide either the original contributor reopen or a later maintainer-authorized reopen. If the current reopener is
  // not visible and confirmed to still be the webhook sender, fail safe by denying the GitHub write. (#2369)
  const reopenerSuperseded = latestReopener.errored || latestReopenerLogin !== reopener;
  if (reopenerSuperseded) {
    await recordAuditEvent(env, {
      eventType: "github_app.reopen_reclosed",
      actor: "loopover",
      targetKey: `${repoFullName}#${pr.number}`,
      outcome: "denied",
      detail: latestReopener.errored
        ? `could not confirm ${reopener} is still the most recent reopener (timeline read failed) — reopen re-close not executed`
        : `the current reopener is now ${latestReopenerLogin ?? "unknown"}, not ${reopener} — reopen re-close not executed`,
      metadata: { deliveryId, repoFullName },
    }).catch(() => undefined);
    return true; // handled (decision made); a confirmed superseding reopener still counts as handled
  }
  // The comment is a courtesy notice; its failure must not mask whether the close itself succeeded (below).
  /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
  await createIssueComment(
    env,
    installationId,
    repoFullName,
    pr.number,
    "This pull request was closed by LoopOver and can't be reopened — reviews are one-shot. Please open a new pull request with the issues resolved.",
  ).catch(() => undefined);
  // #2260: the audit outcome must reflect whether the close actually happened on GitHub, not just whether this
  // handler ran. A swallowed 403/404/5xx here previously still recorded outcome:"completed", so an operator
  // trusting the audit trail believed a one-shot close was enforced when it may not have been.
  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  const originallyClosedBy = closer ?? "LoopOver (close beyond the inspected event window)";
  /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
  await recordAuditEvent(env, {
    eventType: "github_app.reopen_reclosed",
    actor: "loopover",
    targetKey: `${repoFullName}#${pr.number}`,
    outcome: closeError === null ? "completed" : "error",
    detail:
      closeError === null
        ? `re-closed a disallowed reopen by ${reopener} (originally closed by ${originallyClosedBy}) — one-shot; resubmit a new PR`
        : `FAILED to re-close a disallowed reopen by ${reopener} (originally closed by ${originallyClosedBy}) — the close API call did not succeed; the PR may still be open`,
    metadata: closeError === null ? { deliveryId, repoFullName } : { deliveryId, repoFullName, error: errorMessage(closeError) },
  }).catch(() => undefined);
  return true;
}

// Audit eventType for every review-evasion enforcement outcome (#review-evasion-protection). Shared by both
// the self-close and converted_to_draft evasion handlers below so a cross-repo query can scope to exactly
// this family, mirroring github_app.draft_dodge_closed / github_app.reopen_reclosed.
const REVIEW_EVASION_CLOSED_EVENT_TYPE = "github_app.review_evasion_closed";

// Whether `login` holds a maintainer-equivalent permission on repoFullName -- the owner, an ADMIN_GITHUB_LOGINS
// entry, or a collaborator with admin/maintain/write access. Shared by both review-evasion guards below;
// mirrors recloseDisallowedReopenIfNeeded's identical `hasMaintainerPermission` closure (kept as a standalone
// function here since the two guards below do not share an enclosing scope to close over).
async function hasMaintainerOrOwnerPermission(env: Env, installationId: number, repoFullName: string, login: string): Promise<boolean> {
  // The ": \"\"" fallback is unreachable via the real webhook path: repoFullName is always the
  // "owner/repo"-formatted payload.repository.full_name, and the surrounding pipeline already requires a
  // repository match on that exact format before any review-evasion handler runs.
  /* v8 ignore next */
  const repoOwner = repoFullName.includes("/") ? repoFullName.slice(0, repoFullName.indexOf("/")).toLowerCase() : "";
  if (login === repoOwner || parseGitHubLoginList(env.ADMIN_GITHUB_LOGINS).has(login)) return true;
  const permission = await getRepositoryCollaboratorPermission(env, installationId, repoFullName, login).catch(() => null);
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/** Review-evasion protection (#review-evasion-protection, broadened #self-close-post-review): a CONTRIBUTOR
 *  closing their OWN PR after loopover has run a review pass against its current headSha is dodging the
 *  one-shot review, not making an ordinary close. GitHub lets a contributor reopen a PR they closed
 *  themselves but NOT one closed by a maintainer or the App (#one-shot-reopen) -- so this reopens the PR (as
 *  the App) and immediately re-closes it (as the App), converting the contributor's own close into an
 *  App-authored, terminal one they cannot reopen; any later reopen attempt is caught by the EXISTING
 *  maybeRecloseDisallowedReopen guard above. Uses hasReviewedForHeadSha (not hasActiveReviewForHeadSha)
 *  deliberately, mirroring the draft-conversion sibling below: the active-only window closes the instant a
 *  review publishes, but a human reacting to a now-VISIBLE label/comment necessarily acts AFTER that -- the
 *  narrow window could only ever catch someone self-closing blind. Unlike the draft-conversion sibling, this
 *  guard's own enforcement action closes the PR again -- so a redelivered/retried webhook for the SAME
 *  original close must not re-run the reopen/close dance; a live-timeline closer check (mirrors
 *  recloseDisallowedReopenIfNeeded's own pattern) distinguishes that from a genuinely fresh self-close.
 *  `.loopover.yml` settings.autoCloseExemptLogins (the same shared allowlist the draft-conversion/
 *  contributor-cap/review-nag guards already honor) is an explicit escape hatch for trusted contributors.
 *  Per-PR actuation-locked like its draft-dodge/reopen-reclose siblings. The strike only counts once the
 *  enforcement close actually succeeds. */
export async function maybeCloseReviewEvasionSelfClose(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  await withPrActuationLock(env, repoFullName, pr.number, "review-evasion-self-close", () =>
    closeReviewEvasionSelfCloseIfReviewed(env, deliveryId, installationId, repoFullName, pr, payload, settings),
  );
}

async function closeReviewEvasionSelfCloseIfReviewed(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  const closer = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  // Only the PR's OWN author closing their OWN PR is a self-close-evasion candidate -- a third party (e.g. a
  // maintainer) closing someone else's PR is an ordinary maintainer action, not evasion.
  if (!closer || !authorLogin || closer !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  if (isAutoCloseExempt(pr.authorLogin, settings.autoCloseExemptLogins)) return;
  if (!pr.headSha) return;
  const headSha = pr.headSha; // captured so the allowStaleIf closure below keeps the narrowed non-null type
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;
  if (!(await hasReviewedForHeadSha(env, repoFullName, pr.number, headSha))) return;
  // Redelivery/retry safety (#self-close-post-review): hasReviewedForHeadSha stays true for as long as the
  // head doesn't change -- including AFTER this very guard's own enforcement already ran below (reopen+close
  // as the App), unlike hasActiveReviewForHeadSha, which the guard's own terminalizeActiveReviewTracking call
  // used to flip false and rely on for exactly this dedup. A genuinely fresh self-close's most recent closer
  // on the live timeline is the CONTRIBUTOR (this webhook's own sender); once we've already enforced, the
  // live timeline's last closer is loopover's own bot login instead. Check that BEFORE re-running the
  // reopen/close dance so a redelivered webhook for an already-enforced close is a true no-op -- mirrors
  // recloseDisallowedReopenIfNeeded's identical closer-inspection pattern above. An ambiguous read (errored,
  // or a bounded scan that didn't confidently resolve to the bot) falls through to normal enforcement rather
  // than risk silently skipping a genuine evasion attempt -- worst case a rare double-enforcement, not a miss.
  const botLogin = `${env.GITHUB_APP_SLUG}[bot]`.toLowerCase();
  const lastCloser = await getLastCloserLogin(env, installationId, repoFullName, pr.number);
  if ((lastCloser.login?.toLowerCase() ?? null) === botLogin) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const gateMetadata = { deliveryId, repoFullName, headSha };
  const gate = await evaluateCloseEnforcementGate({
    env,
    installationId,
    repoFullName,
    pr,
    settings,
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    targetKey,
    actionLabel: "review-evasion self-close",
    actor: String(pr.authorLogin),
    metadata: gateMetadata,
    dryRun: {
      detail: `dry-run: would reopen + re-close review-evasion self-close by ${pr.authorLogin} -- active review on headSha ${pr.headSha}`,
      metadata: { ...gateMetadata, mode: "dry_run" },
    },
    paused: {
      // paused/frozen -- a complete stop, matching the draft-dodge/reopen-reclose siblings' identical gate.
      detail: `agent actions paused -- review-evasion self-close not enforced for ${pr.authorLogin}`,
      metadata: gateMetadata,
    },
    permissionReadiness: {
      // Write-permission readiness (#2134-style): this enforcement bypasses executeAgentMaintenanceActions
      // entirely (like its draft-dodge/reopen-reclose siblings), so it never got the standard pipeline's
      // PR_WRITE_CLASSES guard.
      detail: `denied review-evasion enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: gateMetadata,
    },
    freshness: {
      detailSuffix: " -- review-evasion enforcement not executed",
      metadata: gateMetadata,
      // Live re-check (#2130-style): the PR's live head may have moved since the webhook was ingested.
      // A legitimate self-close webhook is already closed by definition, so allow that one stale reason only
      // when GitHub still reports the same head SHA we started reviewing; every other stale result means the
      // enforcement justification no longer matches the live PR.
      allowStaleIf: (freshness) =>
        freshness.status === "stale" &&
        freshness.reason === "closed" &&
        freshness.liveHeadSha !== null &&
        freshness.liveHeadSha.toLowerCase() === headSha.toLowerCase(),
    },
  });
  if (!gate.proceed) return;

  const reopenError = await reopenPullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (reopenError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "loopover",
      targetKey,
      outcome: "error",
      detail: `FAILED to reopen ${pr.authorLogin}'s self-close for review-evasion enforcement -- the reopen API call did not succeed`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(reopenError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }
  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "loopover",
      targetKey,
      outcome: "error",
      detail: `FAILED to re-close review-evasion self-close by ${pr.authorLogin} -- the reopen already succeeded, so the PR is live on GitHub as OPEN; retrying via the queue rather than leaving it that way`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    // Deliberately UNCAUGHT: the reopen above already succeeded, so returning normally here would silently
    // leave the PR OPEN on GitHub -- worse than the contributor's original close, and the whole point of
    // this enforcement. Propagate so the queue's own retry/backoff re-processes this job; on retry, the live
    // freshness check earlier in this function will see the PR as open (current, since we just reopened it)
    // and this handler will attempt the re-close again, converging once closePullRequest actually succeeds.
    // The `else` (closeError NOT an Error, falling through to the normalization below) is unreachable in
    // practice -- closePullRequest's only failure path is Octokit's `request()` call, which always rejects
    // with a RequestError (an Error subclass), never a raw thrown value -- but `closeError` is typed
    // `unknown`, so the fallback below stays as a type-safe normalization. The `if` body itself (the real
    // rethrow) IS reachable and IS exercised by the existing re-close-failure tests -- only the else branch
    // (this `if`'s implicit non-Error path) and the fallback statement below are ignored. Concretely: a 500
    // from GitHub on the re-close PATCH makes closePullRequest reject with a RequestError, which is exactly
    // what test/unit/queue-lifecycle-guards.test.ts's "REGRESSION (gate-flagged): a retry after the re-close
    // failure converges -- the PR ends up closed, and the strike is recorded exactly once" drives through this `if`.
    /* v8 ignore else */
    if (closeError instanceof Error) throw closeError;
    /* v8 ignore next -- unreachable, see above. */
    throw new Error(errorMessage(closeError));
  }

  // The close succeeded: post the public explanation, apply the configured label, record the strike -- in
  // that order, after the enforcement close is confirmed (never before).
  const shouldPostSelfCloseComment = settings.reviewEvasionComment ?? true;
  if (shouldPostSelfCloseComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      "LoopOver had already started reviewing this pull request — closing it to dodge the one-shot review process is not allowed. Please open a new pull request with the issues addressed.",
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = resolveNullableLabel(settings.reviewEvasionLabel, DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    /* v8 ignore next -- fail-safe: a label-application failure never blocks the handler (the enforcement close already happened). */
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "loopover",
    targetKey,
    outcome: "completed",
    detail: `re-closed a review-evasion self-close by ${pr.authorLogin} -- active review on headSha ${pr.headSha} was in progress`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  /* v8 ignore next -- best-effort: the guarded CAS update never rejects against a healthy D1, and a cleanup failure here must never block the webhook. */
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (closer/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}

/** Review-evasion protection (#review-evasion-protection, broadened #draft-evasion-post-review): a
 *  contributor converting their OWN OPEN PR to draft after loopover has run a review pass against its
 *  current headSha is dodging the one-shot review, distinct from the EXISTING draft-dodge guard above (which
 *  only fires after a PRIOR gate FAILURE on this head -- this guard fires on ANY reviewed head, block or
 *  not, since the underlying complaint is draft-conversion itself: merge-conflict risk, wasted CI, and
 *  pipeline churn from a PR that already consumed its one-shot review being yanked back to "not ready").
 *  Uses hasReviewedForHeadSha (not hasActiveReviewForHeadSha) deliberately: the active-only window closes
 *  the instant a review publishes, but a human reacting to a now-VISIBLE label/comment necessarily acts
 *  AFTER that -- the narrow window could only ever catch someone converting to draft blind. `.loopover.yml`
 *  settings.autoCloseExemptLogins (the same shared allowlist the contributor-cap/review-nag guards already
 *  honor) is an explicit escape hatch for trusted contributors who legitimately need to keep iterating in
 *  draft after a review. Unlike the self-close sibling, converting to draft never closes the PR on GitHub,
 *  so no reopen step is needed -- a direct close, exactly like the draft-dodge guard's own close step,
 *  suffices. Per-PR actuation-locked like its draft-dodge/reopen-reclose/self-close siblings. */
export async function maybeCloseReviewEvasionDraftConversion(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  await withPrActuationLock(env, repoFullName, pr.number, "review-evasion-draft", () =>
    closeReviewEvasionDraftConversionIfReviewed(env, deliveryId, installationId, repoFullName, pr, payload, settings),
  );
}

async function closeReviewEvasionDraftConversionIfReviewed(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
): Promise<void> {
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  const converter = (payload.sender?.login ?? "").toLowerCase();
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  // Only the PR's OWN author converting their OWN PR to draft is a draft-conversion-evasion candidate -- a
  // third party (e.g. a maintainer converting a contributor's PR to draft) is an ordinary maintainer action,
  // not evasion, and must never be enforced against the AUTHOR who didn't do it (mirrors the self-close
  // sibling's identical actor check).
  if (!converter || !authorLogin || converter !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  if (isAutoCloseExempt(pr.authorLogin, settings.autoCloseExemptLogins)) return;
  if (!pr.headSha) return;
  const headSha = pr.headSha;
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;
  if (!(await hasReviewedForHeadSha(env, repoFullName, pr.number, headSha))) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const gateMetadata = { deliveryId, repoFullName, headSha };
  const gate = await evaluateCloseEnforcementGate({
    env,
    installationId,
    repoFullName,
    pr,
    settings,
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    targetKey,
    actionLabel: "review-evasion draft-conversion",
    actor: String(pr.authorLogin),
    metadata: gateMetadata,
    dryRun: {
      detail: `dry-run: would close review-evasion draft-conversion by ${pr.authorLogin} -- headSha ${pr.headSha} already has a review recorded`,
      metadata: { ...gateMetadata, mode: "dry_run" },
    },
    paused: {
      detail: `agent actions paused -- review-evasion draft-conversion not enforced for ${pr.authorLogin}`,
      metadata: gateMetadata,
    },
    permissionReadiness: {
      detail: `denied review-evasion enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: gateMetadata,
    },
    freshness: {
      // requireDraft: the justification evaporates if the author converted the PR BACK to ready_for_review
      // in the window between ingestion and this check, mirroring the draft-dodge guard's identical fix (#2130).
      requireDraft: true,
      detailSuffix: " -- review-evasion enforcement not executed",
      metadata: gateMetadata,
    },
  });
  if (!gate.proceed) return;

  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "loopover",
      targetKey,
      outcome: "error",
      detail: `FAILED to close review-evasion draft-conversion by ${pr.authorLogin} -- the close API call did not succeed; the PR may still be open`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }

  const shouldPostDraftConversionComment = settings.reviewEvasionComment ?? true;
  if (shouldPostDraftConversionComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      "LoopOver had already started reviewing this pull request — converting it to draft to dodge the one-shot review process is not allowed. Please open a new pull request with the issues addressed.",
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = resolveNullableLabel(settings.reviewEvasionLabel, DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    /* v8 ignore next -- fail-safe: a label-application failure never blocks the handler (the enforcement close already happened). */
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "loopover",
    targetKey,
    outcome: "completed",
    detail: `closed a review-evasion draft-conversion by ${pr.authorLogin} -- headSha ${pr.headSha} had already been reviewed`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  /* v8 ignore next -- best-effort: the guarded CAS update never rejects against a healthy D1, and a cleanup failure here must never block the webhook. */
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (converter/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}

/** Review-evasion protection (#gaming-tactic-draft-cycle): a contributor who converts their OWN PR to draft
 *  more than once is using draft state as a repeated shield to harvest AI-review/CI feedback for free while
 *  dodging the one-shot disposition -- distinct from the two EXISTING draft guards above, which key off a
 *  SPECIFIC head's review/gate state (an active pass, or a prior recorded gate failure) and can both be
 *  legitimately absent on a fast cycle (e.g. converting to draft before either has recorded anything for the
 *  new head at all). This guard instead keys purely on REPETITION: the second (and every later) ready->draft
 *  conversion on the same PR is enforced regardless of the current review/gate state, since the pattern
 *  itself -- not any one head's verdict -- is the abuse signal. A single, first-time draft conversion is
 *  never enforced here (ordinary WIP behavior). Per-PR actuation-locked like its siblings. */
export async function maybeCloseRepeatedDraftCycling(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
  draftConversionCount: number,
): Promise<void> {
  // Checked BEFORE claiming the actuation lock (unlike the two sibling guards above): this guard only ever
  // fires on the >=2nd author-driven conversion of a `reviewEvasionProtection: close` repo, which is rare -- an
  // unconditional lock claim on every converted_to_draft webhook would add avoidable contention with the two
  // siblings above on every repo that never enabled this feature, or on every first-time conversion.
  if (settings.reviewEvasionProtection === "off") return; // #4011: default-ON -- only the explicit opt-out bails
  if (draftConversionCount < 2) return;
  await withPrActuationLock(env, repoFullName, pr.number, "review-evasion-draft-cycle", () =>
    closeRepeatedDraftCyclingIfDetected(env, deliveryId, installationId, repoFullName, pr, payload, settings, draftConversionCount),
  );
}

async function closeRepeatedDraftCyclingIfDetected(
  env: Env,
  deliveryId: string,
  installationId: number,
  repoFullName: string,
  pr: PullRequestRecord,
  payload: GitHubWebhookPayload,
  settings: RepositorySettings,
  draftConversionCount: number,
): Promise<void> {
  // Defense-in-depth (mirrors the two sibling guards' identical actor check): the call site already only ever
  // increments draftConversionCount -- and therefore only ever reaches draftConversionCount >= 2 -- when THIS
  // SAME payload's sender matches the PR's author (both non-empty), so neither `?? ""` fallback below can
  // actually trigger and the guard below can never actually return here today. Kept anyway so a future call
  // site added without that same pre-filter can't silently enforce against the wrong (or a blank) actor.
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  const authorLogin = (pr.authorLogin ?? "").toLowerCase();
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  const converter = (payload.sender?.login ?? "").toLowerCase();
  /* v8 ignore next -- unreachable given the call site's own author-only increment guarantee; see comment above. */
  if (!converter || !authorLogin || converter !== authorLogin) return;
  if (isProtectedAutomationAuthor(pr.authorLogin)) return;
  // Honor the maintainer's trusted-contributor allowlist, same as the two sibling review-evasion guards
  // (closeReviewEvasionSelfCloseIfReviewed / closeReviewEvasionDraftConversionIfReviewed) already do (#6165).
  if (isAutoCloseExempt(pr.authorLogin, settings.autoCloseExemptLogins)) return;
  if (!pr.headSha) return;
  const headSha = pr.headSha;
  if (await hasMaintainerOrOwnerPermission(env, installationId, repoFullName, authorLogin)) return;

  const targetKey = `${repoFullName}#${pr.number}`;
  const gateMetadata = { deliveryId, repoFullName, headSha, draftConversionCount };
  const gate = await evaluateCloseEnforcementGate({
    env,
    installationId,
    repoFullName,
    pr,
    settings,
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    targetKey,
    actionLabel: "repeated draft-cycling",
    actor: `${pr.authorLogin} (conversion #${draftConversionCount})`,
    metadata: gateMetadata,
    dryRun: {
      detail: `dry-run: would close repeated draft-cycling by ${pr.authorLogin} -- conversion #${draftConversionCount}`,
      metadata: { ...gateMetadata, mode: "dry_run" },
    },
    paused: {
      detail: `agent actions paused -- repeated draft-cycling not enforced for ${pr.authorLogin} (conversion #${draftConversionCount})`,
      metadata: gateMetadata,
    },
    permissionReadiness: {
      detail: `denied repeated-draft-cycling enforcement for ${pr.authorLogin} -- pull_requests: write not granted`,
      metadata: gateMetadata,
    },
    freshness: {
      // requireDraft: the justification evaporates if the author converted the PR BACK to ready_for_review in
      // the window between ingestion and this check, mirroring the two sibling guards' identical fix (#2130).
      // A PR already closed moments ago by one of the sibling guards also fails this (status !== "current"),
      // so it is never redundantly re-closed here.
      requireDraft: true,
      detailSuffix: " -- repeated-draft-cycling enforcement not executed",
      metadata: gateMetadata,
    },
  });
  if (!gate.proceed) return;

  const closeError = await closePullRequest(env, installationId, repoFullName, pr.number)
    .then(() => null)
    .catch((error: unknown) => error);
  if (closeError !== null) {
    await recordAuditEvent(env, {
      eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
      actor: "loopover",
      targetKey,
      outcome: "error",
      detail: `FAILED to close repeated draft-cycling by ${pr.authorLogin} -- the close API call did not succeed; the PR may still be open`,
      metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount, error: errorMessage(closeError) },
    }).catch(
      /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
      () => undefined,
    );
    return; // the strike only counts once the enforcement close actually succeeds.
  }

  const shouldPostComment = settings.reviewEvasionComment ?? true;
  if (shouldPostComment) {
    await createIssueComment(
      env,
      installationId,
      repoFullName,
      pr.number,
      `LoopOver detected this pull request has been converted to draft ${draftConversionCount} times — repeatedly cycling between ready and draft to solicit review feedback without a real one-shot attempt is not allowed. Please open a new pull request with the issues addressed.`,
    ).catch(
      /* v8 ignore next -- fail-safe: a courtesy-comment failure never blocks the handler. */
      () => undefined,
    );
  }
  const label = resolveNullableLabel(settings.reviewEvasionLabel, DEFAULT_REVIEW_EVASION_LABEL);
  if (label !== null) {
    /* v8 ignore next -- fail-safe: a label-application failure never blocks the handler (the enforcement close already happened). */
    await ensurePullRequestLabel(env, installationId, repoFullName, pr.number, label, { createMissingLabel: true }).catch(() => undefined);
  }
  await recordAuditEvent(env, {
    eventType: REVIEW_EVASION_CLOSED_EVENT_TYPE,
    actor: "loopover",
    targetKey,
    outcome: "completed",
    detail: `closed repeated draft-cycling by ${pr.authorLogin} -- conversion #${draftConversionCount} on this PR`,
    metadata: { deliveryId, repoFullName, headSha: pr.headSha, draftConversionCount },
  }).catch(
    /* v8 ignore next -- fail-safe: an audit write failure never blocks the handler. */
    () => undefined,
  );
  /* v8 ignore next -- best-effort: the guarded CAS update never rejects against a healthy D1, and a cleanup failure here must never block the webhook. */
  await terminalizeActiveReviewTracking(env, repoFullName, pr.number, { onlyIfHeadSha: pr.headSha }).catch(() => undefined);
  // unreachable implicit-else: the actor guard above already proved pr.authorLogin is a non-empty string
  // (converter/authorLogin are both derived from it and must be truthy to reach this point); the check only
  // exists to narrow the type for applyModerationEscalationForRule's non-nullable authorLogin param.
  /* v8 ignore else */
  if (pr.authorLogin) {
    await applyModerationEscalationForRule(env, {
      installationId,
      repoFullName,
      number: pr.number,
      authorLogin: pr.authorLogin,
      rule: "review_evasion",
      moderationSettings: {
        moderationGateMode: settings.moderationGateMode,
        moderationRules: settings.moderationRules,
        moderationWarningLabel: settings.moderationWarningLabel,
        moderationBannedLabel: settings.moderationBannedLabel,
      },
    }).catch(
      /* v8 ignore next -- fail-safe: an escalation failure never blocks the (already-completed) close. */
      () => undefined,
    );
  }
}
