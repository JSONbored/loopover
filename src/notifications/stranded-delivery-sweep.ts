import { countRecentAuditEventsForActorAndTarget, listStrandedPendingNotificationDeliveries, recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";

/**
 * #9320 — rescue a `notification_deliveries` row stranded at `status: "pending"` by a failed/partial enqueue.
 *
 * `evaluateAndEnqueueNotificationDeliveries` commits each fresh delivery row (idempotent on
 * `UNIQUE(dedup_key, channel)`) BEFORE it enqueues the matching `notify-deliver` job. If that `Promise.all`
 * enqueue rejects for even one delivery (queue backpressure, a transient `JOBS.send` error), the whole call
 * throws — but the rows already committed stay at `pending`. A client retry re-submits the same events, yet the
 * idempotency check now finds those rows already exist (`created: false`) and omits them, so no `notify-deliver`
 * job is ever (re-)sent. The row is invisible to the recipient (`buildNotificationFeed` surfaces only
 * `delivered`/`read`) until the 90-day retention sweep silently deletes it.
 *
 * This mirrors `sweepStrandedPendingClosures` (#9031): a deadline something re-checks, rather than a sequence
 * that depends on one message surviving. `deliverNotification` is already idempotent (it no-ops a row that is no
 * longer `pending`), so replaying `notify-deliver` for a row delivered in the interim is harmless by
 * construction — but the sweep's own query filters on `status: "pending"` so a delivered row is never even
 * re-enqueued, rather than relying solely on that downstream no-op.
 */

export const STRANDED_NOTIFICATION_REQUEUED_EVENT = "notification.delivery.requeued";

/** Grace past a row's creation before the sweep steps in, so a delivery merely waiting its turn behind a busy
 *  queue is never mistaken for a lost one. */
export const STRANDED_NOTIFICATION_GRACE_MS = 10 * 60 * 1000;

/** How far back to scan. A pending row older than this is past rescuing by re-enqueue — the retention sweep is
 *  about to delete it — and the scan stays cheap by not carrying that history forever. */
export const STRANDED_NOTIFICATION_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

/** Minimum spacing between rescues for the same delivery, so a row stuck for a reason the re-enqueue cannot
 *  fix gets retried periodically instead of on every single sweep tick. */
export const STRANDED_NOTIFICATION_REQUEUE_INTERVAL_MS = 60 * 60 * 1000;

/** Bounded rows-per-tick, so one sweep can never fan out an unbounded number of re-enqueues. */
export const STRANDED_NOTIFICATION_SCAN_LIMIT = 500;

export type StrandedNotificationSweepResult = { scanned: number; requeued: number };

export async function sweepStrandedNotificationDeliveries(
  env: Env,
  nowMs: number = Date.now(),
): Promise<StrandedNotificationSweepResult> {
  let deliveries: Awaited<ReturnType<typeof listStrandedPendingNotificationDeliveries>> = [];
  try {
    deliveries = await listStrandedPendingNotificationDeliveries(
      env,
      new Date(nowMs - STRANDED_NOTIFICATION_GRACE_MS).toISOString(),
      new Date(nowMs - STRANDED_NOTIFICATION_LOOKBACK_MS).toISOString(),
      STRANDED_NOTIFICATION_SCAN_LIMIT,
    );
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "stranded_notification_sweep_scan_failed", message: errorMessage(error).slice(0, 160) }));
    return { scanned: 0, requeued: 0 };
  }

  let requeued = 0;
  for (const delivery of deliveries) {
    // Spacing gate: skip a delivery re-enqueued within the interval. An unreadable ledger falls back to
    // "already rescued" (1) so a broken audit read can never turn the sweep into a per-tick flood.
    const recent = await countRecentAuditEventsForActorAndTarget(
      env,
      "loopover",
      STRANDED_NOTIFICATION_REQUEUED_EVENT,
      delivery.id,
      new Date(nowMs - STRANDED_NOTIFICATION_REQUEUE_INTERVAL_MS).toISOString(),
    ).catch(() => 1);
    if (recent > 0) continue;

    const sent = await env.JOBS.send({ type: "notify-deliver", requestedBy: "notify-evaluate", deliveryId: delivery.id })
      .then(() => true)
      .catch(() => false);
    if (!sent) continue;
    requeued += 1;
    // Best-effort ledger, exactly like the enqueue it accompanies: losing this bookkeeping row must not undo a
    // rescue that already reached the queue — the next tick's spacing gate simply re-evaluates from scratch.
    await recordAuditEvent(env, {
      eventType: STRANDED_NOTIFICATION_REQUEUED_EVENT,
      actor: "loopover",
      targetKey: delivery.id,
      outcome: "queued",
      detail: "notify-deliver re-enqueued for a delivery stranded at pending past its grace period",
      metadata: { deliveryId: delivery.id, recipientLogin: delivery.recipientLogin, channel: delivery.channel },
    }).catch(() => undefined);
  }
  return { scanned: deliveries.length, requeued };
}
