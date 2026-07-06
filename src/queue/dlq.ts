import { getWebhookEvent, recordAuditEvent } from "../db/repositories";
import { delayUntil, LOW_REST_RATE_LIMIT_REMAINING, shouldWaitForGitHubRateLimit } from "../github/rate-limit";
import { incr } from "../selfhost/metrics";
import { githubRateLimitAdmissionKeyForJob } from "../selfhost/queue-common";
import type { JobMessage, JsonValue } from "../types";

const DLQ_DEAD_LETTERED_METRIC = "gittensory_dlq_dead_lettered_total";
const DLQ_REDRIVEN_METRIC = "gittensory_dlq_redriven_total";

/**
 * DLQ consumer for both `gittensory-jobs-dlq` (maintenance lane) and `gittensory-webhooks-dlq` (the
 * webhook lane added with the dedicated WEBHOOKS queue, #1276). Called when a job exhausts all retries
 * on its main queue and is dead-lettered. Logs every dropped job and records an audit event so the drop
 * is observable rather than silent (countRecentDeadLetters surfaces the rate). Always acks — no further
 * retries on DLQ messages.
 *
 * Self-heal: a dead-lettered `github-webhook` carries a real GitHub event that GitHub will NOT redeliver
 * (the HTTP handler already returned 202). So unless it was already processed, RE-DRIVE it ONCE back onto
 * the webhook lane — bounded to a single attempt by the `redriven` marker so a genuinely-poison payload
 * cannot loop the DLQ forever. Maintenance jobs are cron-self-healing, so they are audited-and-dropped.
 */
export async function processDlqBatch(batch: MessageBatch<JobMessage>, env: Env, options: { redriveWebhooks?: boolean } = {}): Promise<void> {
  const redriveWebhooks = options.redriveWebhooks ?? true;
  for (const message of batch.messages) {
    const body = message.body as { type?: string } | null | undefined;
    const jobType = body?.type ?? "unknown";
    const webhook = jobType === "github-webhook" ? (message.body as Extract<JobMessage, { type: "github-webhook" }> & { redriven?: boolean }) : null;
    const redriven = webhook?.redriven === true;
    incr(DLQ_DEAD_LETTERED_METRIC, { jobType, redriven: redriven ? "true" : "false" });
    console.error(
      JSON.stringify({
        level: "error",
        event: "dlq_message_dead_lettered",
        messageId: message.id,
        jobType,
        ...(webhook ? { deliveryId: webhook.deliveryId, eventName: webhook.eventName } : {}),
      }),
    );
    // Best-effort audit record — never block the ack on a write failure.
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: `dlq:${jobType}:${message.id}`,
      outcome: "error",
      detail: `Job of type '${jobType}' exhausted all retries and was dead-lettered.`,
      metadata: { messageId: message.id, jobType, redriven } satisfies Record<string, JsonValue>,
    }).catch(() => undefined);
    // Self-heal a recoverable webhook: re-drive ONCE (not already re-driven, and not already processed).
    if (redriveWebhooks && webhook && !redriven && webhook.deliveryId) {
      const event = await getWebhookEvent(env, webhook.deliveryId).catch(() => null);
      if (event?.status !== "processed") {
        // If the webhook dead-lettered because the shared GitHub REST budget was exhausted, re-drive it AFTER the
        // reset (retry-until-recovered) rather than immediately re-failing it. (#audit-rate-headroom) Scoped to
        // THIS webhook's own installation bucket (#audit-rate-scoping) so an unrelated installation's exhaustion
        // never delays this re-drive.
        const resetAt = await shouldWaitForGitHubRateLimit(env, LOW_REST_RATE_LIMIT_REMAINING, githubRateLimitAdmissionKeyForJob(webhook) ?? undefined).catch(() => undefined);
        const options = resetAt ? { delaySeconds: delayUntil(resetAt) } : undefined;
        const queue = env.WEBHOOKS;
        if (queue) {
          await queue
            .send({ type: "github-webhook", deliveryId: webhook.deliveryId, eventName: webhook.eventName, payload: webhook.payload, redriven: true }, options)
            .then(() => {
              incr(DLQ_REDRIVEN_METRIC, { eventName: webhook.eventName });
            })
            .catch(() => undefined);
        }
      }
    }
    message.ack();
  }
}
