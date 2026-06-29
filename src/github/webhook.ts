import type { Context } from "hono";
import { getWebhookEvent, recordWebhookEvent } from "../db/repositories";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { sha256Hex, verifyGitHubSignature } from "../utils/crypto";
import { parsePositiveInt } from "../utils/json";
import { relayVerify } from "../orb/relay";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { isSelfAuthoredWebhookNoise } from "./self-authored";

const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

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
  const result = await enqueueWebhookByEnv(c.env, deliveryId, eventName, rawBody);
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
export async function enqueueWebhookByEnv(env: Env, deliveryId: string, eventName: string, rawBody: string): Promise<EnqueueWebhookResult> {
  if (!isSelfHostedReviewRuntime(env)) return "review_unavailable";

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    return "invalid_json";
  }

  const payloadHash = await sha256Hex(rawBody);
  const existingEvent = await getWebhookEvent(env, deliveryId);
  // Suppress redelivery of an already-processed event (on success its payloadHash is overwritten to a
  // "processed" sentinel, so a hash match alone misses it and the event re-runs its side effects) or one
  // still in flight with the same payload. "error" rows are never suppressed so a failed enqueue/processing
  // can still be retried (#789).
  if (existingEvent && existingEvent.status !== "error" && (existingEvent.status === "processed" || existingEvent.payloadHash === payloadHash)) {
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
  if (isSelfAuthoredWebhookNoise(env, eventName, payload)) {
    await recordWebhookEvent(env, { ...eventRow, status: "processed" });
    return "ignored";
  }
  if (!env.WEBHOOKS) {
    await recordWebhookEvent(env, { ...eventRow, status: "error" });
    return "enqueue_failed";
  }

  await recordWebhookEvent(env, { ...eventRow, status: "queued" });

  const message: JobMessage = { type: "github-webhook", deliveryId, eventName, payload };
  try {
    // Send to the dedicated WEBHOOKS lane (not the shared JOBS queue) so a maintenance burst on JOBS can never
    // starve real GitHub events into the DLQ. (#audit-webhook-queue)
    await env.WEBHOOKS.send(message);
  } catch {
    // Enqueue failed: flip the event to "error" so the dedup guard above lets GitHub redeliver / the next pull
    // re-deliver, instead of treating the webhook as handled (#786). Also covers the deploy-ordering case where
    // the WEBHOOKS queue is not yet provisioned — no event is lost.
    await recordWebhookEvent(env, { ...eventRow, status: "error" });
    return "enqueue_failed";
  }

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
