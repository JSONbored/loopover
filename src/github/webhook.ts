import type { Context } from "hono";
import { getWebhookEvent, recordWebhookEvent } from "../db/repositories";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { sha256Hex, verifyGitHubSignature } from "../utils/crypto";
import { parsePositiveInt } from "../utils/json";
import { relayVerify } from "../orb/relay";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { incr } from "../selfhost/metrics";
import { getSelfHostRequestTraceParent } from "../selfhost/trace-context";
import { isNonActionableWebhookNoise } from "./self-authored";

const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const WEBHOOK_METRIC_EVENTS = new Set([
  "check_run",
  "check_suite",
  "installation",
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
]);
const WEBHOOK_METRIC_ACTIONS = new Set([
  "assigned",
  "auto_merge_disabled",
  "auto_merge_enabled",
  "closed",
  "completed",
  "converted_to_draft",
  "created",
  "deleted",
  "demilestoned",
  "dequeued",
  "dismissed",
  "edited",
  "enqueued",
  "labeled",
  "locked",
  "milestoned",
  "new_permissions_accepted",
  "opened",
  "pinned",
  "ready_for_review",
  "reopened",
  "requested",
  "requested_action",
  "rerequested",
  "review_request_removed",
  "review_requested",
  "submitted",
  "suspend",
  "synchronize",
  "transferred",
  "unassigned",
  "unlabeled",
  "unlocked",
  "unpinned",
  "unsuspend",
]);

function webhookMetricEvent(eventName: string): string {
  return WEBHOOK_METRIC_EVENTS.has(eventName) ? eventName : "other";
}

function webhookMetricAction(action: unknown): string {
  if (typeof action !== "string") return "none";
  return WEBHOOK_METRIC_ACTIONS.has(action) ? action : "other";
}

function recordWebhookEnqueueMetric(
  eventName: string,
  action: unknown,
  result: EnqueueWebhookResult,
): void {
  incr("gittensory_webhook_enqueue_total", {
    action: webhookMetricAction(action),
    event: webhookMetricEvent(eventName),
    result,
  });
}

export async function handleGitHubWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const deliveryId = c.req.header("x-github-delivery") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!deliveryId || !eventName) {
    return c.json({ error: "missing_github_headers" }, 400);
  }

  const maxBodyBytes = parsePositiveInt(c.env.GITHUB_WEBHOOK_MAX_BODY_BYTES) ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  const contentLength = parsePositiveInt(c.req.header("content-length"));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    return c.json({ error: "payload_too_large", maxBytes: maxBodyBytes }, 413);
  }

  const rawBody = await readBodyWithLimit(c.req.raw, maxBodyBytes);
  if (rawBody === null) {
    return c.json({ error: "payload_too_large", maxBytes: maxBodyBytes }, 413);
  }
  const verified = await verifyGitHubSignature(rawBody, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!verified) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  return enqueueVerifiedWebhook(c, deliveryId, eventName, rawBody);
}

/** Shared post-verification path: parse → dedup → record → enqueue to the WEBHOOKS lane → 202. Used by the GitHub
 *  webhook receiver above AND the Orb relay receiver below (they verify the body differently — GitHub's HMAC vs the
 *  Orb relay HMAC — then share everything after). */
export async function enqueueVerifiedWebhook(c: Context<{ Bindings: Env }>, deliveryId: string, eventName: string, rawBody: string): Promise<Response> {
  const result = await enqueueWebhookByEnv(c.env, deliveryId, eventName, rawBody, getSelfHostRequestTraceParent(c.req.raw));
  switch (result) {
    case "review_unavailable":
      return c.json({ error: "selfhost_review_runtime_required" }, 410);
    case "ignored":
      return c.json({ ok: true, deliveryId, eventName, status: "ignored" }, 202);
    case "invalid_json":
      return c.json({ error: "invalid_json" }, 400);
    case "duplicate":
      return c.json({ ok: true, deliveryId, eventName, status: "duplicate" }, 202);
    case "enqueue_failed":
      return c.json({ error: "enqueue_failed", deliveryId }, 500);
    default:
      return c.json({ ok: true, deliveryId, eventName, status: "queued" }, 202);
  }
}

export type EnqueueWebhookResult = "queued" | "duplicate" | "ignored" | "invalid_json" | "enqueue_failed" | "review_unavailable";

/** Env-based core of the webhook enqueue (parse → dedup → record → WEBHOOKS lane), with NO Hono Context. Shared by
 *  the request-context receiver above AND the pull-mode relay drain loop (server.ts), which has no Context. Returns
 *  a status the caller maps to a response / an ack decision.
 *
 *  This is the retired direct review-app receiver, not the central Orb ingress. The Orb App still receives GitHub
 *  webhooks at /v1/orb/webhook and forwards/pends them for registered self-host engines. Direct review execution
 *  now requires the self-host runtime cache so stale Cloudflare review-webhook traffic fails loudly instead of being
 *  accepted into a Worker path that no longer performs reviews. */
export async function enqueueWebhookByEnv(env: Env, deliveryId: string, eventName: string, rawBody: string, traceParent?: string): Promise<EnqueueWebhookResult> {
  if (!isSelfHostedReviewRuntime(env)) {
    recordWebhookEnqueueMetric(eventName, undefined, "review_unavailable");
    return "review_unavailable";
  }

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    recordWebhookEnqueueMetric(eventName, undefined, "invalid_json");
    return "invalid_json";
  }

  const payloadHash = await sha256Hex(rawBody);
  const existingEvent = await getWebhookEvent(env, deliveryId);
  // Suppress redelivery of an already-processed event (on success its payloadHash is overwritten to a
  // "processed" sentinel, so a hash match alone misses it and the event re-runs its side effects) or one
  // still in flight with the same payload. "error" rows are never suppressed so a failed enqueue/processing
  // can still be retried (#789).
  if (existingEvent && existingEvent.status !== "error" && (existingEvent.status === "processed" || existingEvent.payloadHash === payloadHash)) {
    recordWebhookEnqueueMetric(eventName, payload.action, "duplicate");
    return "duplicate";
  }

  const eventRow = {
    deliveryId,
    eventName,
    action: payload.action,
    installationId: payload.installation?.id,
    repositoryFullName: payload.repository?.full_name,
    payloadHash,
  };
  if (isNonActionableWebhookNoise(env, eventName, payload)) {
    await recordWebhookEvent(env, { ...eventRow, status: "processed" });
    recordWebhookEnqueueMetric(eventName, payload.action, "ignored");
    return "ignored";
  }
  if (!env.WEBHOOKS) {
    await recordWebhookEvent(env, { ...eventRow, status: "error" });
    recordWebhookEnqueueMetric(eventName, payload.action, "enqueue_failed");
    // Missing binding is a deploy-ordering defect (the WEBHOOKS queue isn't provisioned yet), not a transient
    // blip — an operator needs to SEE it, not infer it from a metric dip. ERROR level so the central Sentry
    // forwarder captures it (#1824); repository/installation stay out of the tags (webhook ingest observability).
    console.error(
      JSON.stringify({
        level: "error",
        event: "selfhost_webhook_enqueue_binding_missing",
        eventName,
        repository: eventRow.repositoryFullName,
      }),
    );
    return "enqueue_failed";
  }

  await recordWebhookEvent(env, { ...eventRow, status: "queued" });

  const message: JobMessage = { type: "github-webhook", deliveryId, eventName, payload, ...(traceParent ? { traceParent } : {}) };
  try {
    // Send to the dedicated WEBHOOKS lane (not the shared JOBS queue) so a maintenance burst on JOBS can never
    // starve real GitHub events into the DLQ. (#audit-webhook-queue)
    await env.WEBHOOKS.send(message);
  } catch (error) {
    // Enqueue failed: flip the event to "error" so the dedup guard above lets GitHub redeliver / the next pull
    // re-deliver, instead of treating the webhook as handled (#786). Also covers the deploy-ordering case where
    // the WEBHOOKS queue is not yet provisioned — no event is lost.
    await recordWebhookEvent(env, { ...eventRow, status: "error" });
    recordWebhookEnqueueMetric(eventName, payload.action, "enqueue_failed");
    // ERROR level so the central Sentry forwarder captures a failing webhook enqueue (#1824) — previously only a
    // Prometheus counter moved, which an operator would only notice by comparing dashboards. Never logs rawBody or
    // the parsed payload (secret-scrub boundary); only the delivery's routing metadata.
    console.error(
      JSON.stringify({
        level: "error",
        event: "selfhost_webhook_enqueue_failed",
        eventName,
        repository: eventRow.repositoryFullName,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return "enqueue_failed";
  }

  recordWebhookEnqueueMetric(eventName, payload.action, "queued");
  return "queued";
}

/** The brokered self-host's relay RECEIVER. The central Orb forwards an event here, HMAC-signed (x-orb-signature-
 *  256) with THIS container's enrollment secret. We verify with our own ORB_ENROLLMENT_SECRET, then enqueue the
 *  event exactly like a GitHub webhook (the body IS a GitHub webhook payload; only the transport differs). */
export async function handleOrbRelay(c: Context<{ Bindings: Env }>): Promise<Response> {
  const deliveryId = c.req.header("x-github-delivery") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;
  if (!deliveryId || !eventName) return c.json({ error: "missing_github_headers" }, 400);
  const secret = c.env.ORB_ENROLLMENT_SECRET;
  if (!secret) return c.json({ error: "relay_not_configured" }, 404); // not a brokered self-host → no relay
  const maxBodyBytes = parsePositiveInt(c.env.GITHUB_WEBHOOK_MAX_BODY_BYTES) ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  const rawBody = await readBodyWithLimit(c.req.raw, maxBodyBytes);
  if (rawBody === null) return c.json({ error: "payload_too_large", maxBytes: maxBodyBytes }, 413);
  if (!(await relayVerify(secret, rawBody, c.req.header("x-orb-signature-256") ?? null))) {
    return c.json({ error: "invalid_signature" }, 401);
  }
  return enqueueVerifiedWebhook(c, deliveryId, eventName, rawBody);
}

async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) return null;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}
