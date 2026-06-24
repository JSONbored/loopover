import { recordAuditEvent } from "../db/repositories";
import type { JobMessage, JsonValue } from "../types";

/**
 * DLQ consumer for `gittensory-jobs-dlq`. Called when a job exhausts all retries on the main
 * queue and is dead-lettered. Logs every dropped job for observability and records an audit event
 * so maintainers can investigate persistent failures via the dashboard. Always acks — no further
 * retries on DLQ messages.
 */
export async function processDlqBatch(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body as { type?: string; deliveryId?: string; eventName?: string } | null | undefined;
    const jobType = body?.type ?? "unknown";
    console.error(
      JSON.stringify({
        level: "error",
        event: "dlq_message_dead_lettered",
        messageId: message.id,
        jobType,
        ...(jobType === "github-webhook" ? { deliveryId: body?.deliveryId, eventName: body?.eventName } : {}),
      }),
    );
    // Best-effort audit record — never block the ack on a write failure.
    await recordAuditEvent(env, {
      eventType: "github_app.dlq_dead_lettered",
      actor: "gittensory",
      targetKey: `dlq:${jobType}:${message.id}`,
      outcome: "error",
      detail: `Job of type '${jobType}' exhausted all retries and was dead-lettered.`,
      metadata: { messageId: message.id, jobType } satisfies Record<string, JsonValue>,
    }).catch(() => undefined);
    message.ack();
  }
}
