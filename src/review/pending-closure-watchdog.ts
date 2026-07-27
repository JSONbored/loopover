import { countRecentAuditEventsForActorAndTarget, getPullRequest, listAuditEventsByType, recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";

/**
 * #9031 — rescue a PR stranded mid-way through the flag-then-close double-check.
 *
 * Pass 1 applies the pending-closure label and enqueues a single delayed `recapture-preview` job to run Pass 2.
 * Until then that one queue message was the ONLY thing that could finish the sequence. Its documented backstop —
 * "the next sweep / CI event" — is largely vacuous: #never-endless-reregate makes an already-regated PR
 * permanently sweep-ineligible, and the flag itself suppresses merge and approve via `linkedIssueCloseInFlight`.
 * So if the queue lost the job (a crash mid-flight, #9007), the PR sat flagged with pending-closure plus
 * changes-requested, going nowhere, waiting on a contributor webhook that may never come — and because the
 * violation memory is permanent, `clearLinkedIssueFlag` could never fire either.
 *
 * The fix the issue asks for is a deadline something re-checks, rather than a sequence that depends on one
 * message surviving. Pass 1 now records an audit event carrying that deadline, and this watchdog re-enqueues
 * Pass 2 for any flag past it. `audit_events` is the right store for this: durable, already queried by type,
 * and repo-agnostic — unlike the label, which is per-repo configurable and would need settings resolution
 * before a cross-repo scan could even recognize it.
 *
 * The re-enqueued job is the same message Pass 1 sends, so a redundant one is harmless: Pass 2 is a re-review
 * that re-derives everything from live state.
 */

export const PENDING_CLOSURE_FLAGGED_EVENT = "agent.linked_issue.pending_closure_flagged";
export const PENDING_CLOSURE_REQUEUED_EVENT = "agent.linked_issue.pending_closure_requeued";

/** Grace beyond the flag's own deadline before the watchdog steps in, so a job merely waiting its turn behind a
 *  busy queue is never mistaken for a lost one. */
export const PENDING_CLOSURE_GRACE_MS = 10 * 60 * 1000;

/** How far back to scan. A flag older than this is past rescuing by re-enqueue — the PR has moved on, or a
 *  human has dealt with it — and the scan stays cheap by not carrying that history forever. */
export const PENDING_CLOSURE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum spacing between rescues for the same PR, so a PR that is stuck for a reason the re-enqueue cannot
 *  fix gets retried periodically instead of on every single sweep tick. */
export const PENDING_CLOSURE_REQUEUE_INTERVAL_MS = 60 * 60 * 1000;

export type PendingClosureSweepResult = { scanned: number; requeued: number };

/** Pass 1's durable record that a flag was applied and when its verification is due. Best-effort, exactly like
 *  the enqueue it accompanies — but the two failing together is far less likely than the single message being
 *  lost, which is the whole point of having both. */
export async function recordPendingClosureFlag(
  env: Env,
  target: { repoFullName: string; pullNumber: number; installationId: number },
  dueAtMs: number,
): Promise<void> {
  await recordAuditEvent(env, {
    eventType: PENDING_CLOSURE_FLAGGED_EVENT,
    actor: "loopover",
    targetKey: `${target.repoFullName}#${target.pullNumber}`,
    outcome: "queued",
    detail: "pending-closure flag applied; Pass 2 verification scheduled",
    metadata: { repoFullName: target.repoFullName, pullNumber: target.pullNumber, installationId: target.installationId, dueAt: new Date(dueAtMs).toISOString() },
  }).catch(() => undefined);
}

export async function sweepStrandedPendingClosures(env: Env, nowMs: number = Date.now()): Promise<PendingClosureSweepResult> {
  let flags: Awaited<ReturnType<typeof listAuditEventsByType>> = [];
  try {
    flags = await listAuditEventsByType(env, PENDING_CLOSURE_FLAGGED_EVENT, new Date(nowMs - PENDING_CLOSURE_LOOKBACK_MS).toISOString(), 500);
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "pending_closure_sweep_scan_failed", message: errorMessage(error).slice(0, 160) }));
    return { scanned: 0, requeued: 0 };
  }

  let requeued = 0;
  for (const flag of flags) {
    const repoFullName = typeof flag.metadata.repoFullName === "string" ? flag.metadata.repoFullName : null;
    const pullNumber = typeof flag.metadata.pullNumber === "number" ? flag.metadata.pullNumber : null;
    const installationId = typeof flag.metadata.installationId === "number" ? flag.metadata.installationId : null;
    if (repoFullName === null || pullNumber === null || installationId === null) continue;
    const dueAt = typeof flag.metadata.dueAt === "string" ? Date.parse(flag.metadata.dueAt) : NaN;
    // An unreadable deadline falls back to the event's own timestamp: the flag is still real, and refusing to
    // rescue it because its metadata is malformed would recreate the exact stranding this exists to end.
    const deadline = Number.isFinite(dueAt) ? dueAt : Date.parse(flag.createdAt);
    if (!Number.isFinite(deadline) || nowMs < deadline + PENDING_CLOSURE_GRACE_MS) continue;

    // Only an OPEN PR can still be stranded. A closed/merged one already reached a terminal state, whether by
    // Pass 2, a maintainer, or the contributor.
    const pr = await getPullRequest(env, repoFullName, pullNumber).catch(() => null);
    if (!pr || pr.state !== "open") continue;

    const targetKey = `${repoFullName}#${pullNumber}`;
    const recent = await countRecentAuditEventsForActorAndTarget(
      env,
      "loopover",
      PENDING_CLOSURE_REQUEUED_EVENT,
      targetKey,
      new Date(nowMs - PENDING_CLOSURE_REQUEUE_INTERVAL_MS).toISOString(),
    ).catch(() => 1);
    if (recent > 0) continue;

    const verifyJob = {
      type: "recapture-preview" as const,
      deliveryId: `linked-issue-verify:${repoFullName}#${pullNumber}`,
      repoFullName,
      prNumber: pullNumber,
      installationId,
      attempt: 0,
    };
    const sent = await env.JOBS.send(verifyJob)
      .then(() => true)
      .catch(() => false);
    if (!sent) continue;
    requeued += 1;
    await recordAuditEvent(env, {
      eventType: PENDING_CLOSURE_REQUEUED_EVENT,
      actor: "loopover",
      targetKey,
      outcome: "queued",
      detail: "pending-closure verification re-enqueued after its deadline passed with the PR still flagged",
      metadata: { repoFullName, pullNumber, installationId, deadline: new Date(deadline).toISOString() },
    }).catch(() => undefined);
  }
  return { scanned: flags.length, requeued };
}
