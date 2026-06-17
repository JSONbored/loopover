import type { Context } from "hono";
import { getWebhookEvent, recordWebhookEvent } from "../db/repositories";
import type { GitHubWebhookPayload, JobMessage } from "../types";
import { sha256Hex, verifyGitHubSignature } from "../utils/crypto";

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

  let payload: GitHubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as GitHubWebhookPayload;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const payloadHash = await sha256Hex(rawBody);
  const existingEvent = await getWebhookEvent(c.env, deliveryId);
  // Suppress redelivery of an already-processed event (on success its payloadHash is overwritten to a
  // "processed" sentinel, so a hash match alone misses it and the event re-runs its side effects) or one
  // still in flight with the same payload. "error" rows are never suppressed so a failed enqueue/processing
  // can still be retried (#789).
  if (existingEvent && existingEvent.status !== "error" && (existingEvent.status === "processed" || existingEvent.payloadHash === payloadHash)) {
    return c.json({ ok: true, deliveryId, eventName, status: "duplicate" }, 202);
  }

  await recordWebhookEvent(c.env, {
    deliveryId,
    eventName,
    action: payload.action,
    installationId: payload.installation?.id,
    repositoryFullName: payload.repository?.full_name,
    payloadHash,
    status: "queued",
  });

  const message: JobMessage = {
    type: "github-webhook",
    deliveryId,
    eventName,
    payload,
  };
  try {
    await c.env.JOBS.send(message);
  } catch {
    // Enqueue failed: flip the event to "error" so the dedup guard above lets GitHub redeliver,
    // and return 500 so GitHub retries instead of treating the webhook as handled (#786).
    await recordWebhookEvent(c.env, {
      deliveryId,
      eventName,
      action: payload.action,
      installationId: payload.installation?.id,
      repositoryFullName: payload.repository?.full_name,
      payloadHash,
      status: "error",
    });
    return c.json({ error: "enqueue_failed", deliveryId }, 500);
  }

  return c.json({ ok: true, deliveryId, eventName, status: "queued" }, 202);
}

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
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
