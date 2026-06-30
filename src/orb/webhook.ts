// Gittensory Orb central GitHub App (#1255) — inbound webhook receiver (POST /v1/orb/webhook).
//
// The central Orb App is a SEPARATE GitHub App that maintainers INSTALL (one shared app, like
// das-github-mirror's). GitHub delivers its install + PR/review events here, to gittensory-api. This is the
// data spine for the homepage fleet metrics (reviews initiated / merged / closed / reversals).
//
// PR1 scope: receive + verify (the Orb App's OWN webhook secret) + dedup + record. NO processing yet — the
// install registry and PR-outcome aggregation land in later PRs, reading from orb_webhook_events. This mirrors
// the proven src/github/webhook.ts handler verbatim; only the secret + dedup table differ.
import type { Context } from "hono";
import type { GitHubWebhookPayload } from "../types";
import { sha256Hex, verifyGitHubSignature } from "../utils/crypto";
import { parsePositiveInt } from "../utils/json";
import { upsertOrbInstallation } from "./installations";
import { recordOrbPrOutcome } from "./outcomes";
import { forwardOrbEvent, storeRelayFailure } from "./relay";

const DEFAULT_MAX_ORB_WEBHOOK_BODY_BYTES = 1024 * 1024;

export async function handleOrbWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const deliveryId = c.req.header("x-github-delivery") ?? null;
  const eventName = c.req.header("x-github-event") ?? null;
  const signature = c.req.header("x-hub-signature-256") ?? null;
  if (!deliveryId || !eventName) {
    return c.json({ error: "missing_github_headers" }, 400);
  }

  const maxBodyBytes = parsePositiveInt(c.env.GITHUB_WEBHOOK_MAX_BODY_BYTES) ?? DEFAULT_MAX_ORB_WEBHOOK_BODY_BYTES;
  const contentLength = parsePositiveInt(c.req.header("content-length"));
  if (contentLength !== null && contentLength > maxBodyBytes) {
    return c.json({ error: "payload_too_large", maxBytes: maxBodyBytes }, 413);
  }

  const rawBody = await readBodyWithLimit(c.req.raw, maxBodyBytes);
  if (rawBody === null) {
    return c.json({ error: "payload_too_large", maxBytes: maxBodyBytes }, 413);
  }
  // The Orb App's OWN webhook secret — distinct from the review app's GITHUB_WEBHOOK_SECRET. Absent secret →
  // verifyGitHubSignature returns false → 401 (fail-closed), so this route is inert until the secret is injected.
  const verified = await verifyGitHubSignature(rawBody, signature, c.env.ORB_GITHUB_WEBHOOK_SECRET ?? "");
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
  const existing = await getOrbWebhookEvent(c.env, deliveryId);
  // Suppress redelivery of an already-recorded delivery (same payload) or a processed one; "error" rows are
  // never suppressed so a failed record can be retried — same semantics as the review-app handler (#789).
  if (existing && existing.status !== "error" && (existing.status === "processed" || existing.payloadHash === payloadHash)) {
    return c.json({ ok: true, deliveryId, eventName, status: "duplicate" }, 202);
  }

  const eventMeta = {
    deliveryId,
    eventName,
    action: payload.action ?? null,
    installationId: payload.installation?.id ?? null,
    repositoryFullName: payload.repository?.full_name ?? null,
    payloadHash,
  };

  // Maintain the installation registry from `installation` lifecycle events, and record terminal PR outcomes
  // from `pull_request closed` events, BEFORE recording the webhook row — so a failed write is flipped to
  // "error" + 500 and GitHub redelivers (the dedup guard only suppresses non-error rows). Each is a no-op for
  // every unrelated event.
  try {
    await upsertOrbInstallation(c.env, eventName, payload);
    await recordOrbPrOutcome(c.env, eventName, payload);
  } catch {
    await recordOrbWebhookEvent(c.env, { ...eventMeta, status: "error" });
    return c.json({ error: "processing_failed", deliveryId }, 500);
  }

  await recordOrbWebhookEvent(c.env, { ...eventMeta, status: "received" });
  // Forward to a brokered self-host registered for this installation — but NEVER block the 202 we owe GitHub on it.
  // A push-mode forward POSTs to the container's relay URL with a 10s timeout; a slow (e.g. tailnet) container would
  // otherwise delay our response past GitHub's ~10s delivery deadline, so GitHub marks the delivery FAILED even
  // though we received + queued it. Run the forward (+ its failure-persistence for the retry cron) AFTER the
  // response via waitUntil. (#orb-ack-fast)
  scheduleAfterResponse(c, relayForward(c.env, { eventName, installationId: payload.installation?.id, deliveryId, rawBody }));
  return c.json({ ok: true, deliveryId, eventName, status: "received" }, 202);
}

/** Forward an Orb webhook to the brokered self-host registered for the installation, persisting a FAILED push for
 *  the retry-orb-relay cron (a temporarily-down container recovers without losing events; max 5 attempts / 1h TTL).
 *  Self-contained + fail-safe (never throws) so it can run AFTER the response via {@link scheduleAfterResponse}. */
export async function relayForward(
  env: Env,
  args: { eventName: string; installationId: number | null | undefined; deliveryId: string; rawBody: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const relayResult = await forwardOrbEvent(env, args, fetchImpl);
    // forwardOrbEvent returns "failed" only for an ENROLLED install (a null/absent id "skips"), so installationId is
    // non-null here — persist the failed push so the retry-orb-relay cron re-attempts it.
    if (relayResult === "failed") {
      await storeRelayFailure(env, { deliveryId: args.deliveryId, eventName: args.eventName, installationId: args.installationId!, rawBody: args.rawBody });
    }
  } catch {
    /* v8 ignore next -- fail-safe: a forward/persist error must never surface from the deferred task */
  }
}

/** Run `task` AFTER the response is sent (Cloudflare Workers `waitUntil`), so a slow downstream relay forward can't
 *  delay the webhook ACK past GitHub's ~10s delivery deadline. Falls back to fire-and-forget where there is no
 *  execution context (e.g. a unit-test harness); the self-host server provides its own waitUntil shim. */
function scheduleAfterResponse(c: Context<{ Bindings: Env }>, task: Promise<unknown>): void {
  try {
    (c.executionCtx as unknown as { waitUntil(p: Promise<unknown>): void }).waitUntil(task);
  } catch {
    void task;
  }
}

async function getOrbWebhookEvent(env: Env, deliveryId: string): Promise<{ payloadHash: string; status: string } | null> {
  const row = await env.DB.prepare("SELECT payload_hash AS payloadHash, status FROM orb_webhook_events WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<{ payloadHash: string; status: string }>();
  return row ?? null;
}

async function recordOrbWebhookEvent(
  env: Env,
  e: { deliveryId: string; eventName: string; action: string | null; installationId: number | null; repositoryFullName: string | null; payloadHash: string; status: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orb_webhook_events (delivery_id, event_name, action, installation_id, repository_full_name, payload_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO UPDATE SET
       status = excluded.status, payload_hash = excluded.payload_hash, action = excluded.action,
       installation_id = excluded.installation_id, repository_full_name = excluded.repository_full_name`,
  )
    .bind(e.deliveryId, e.eventName, e.action, e.installationId, e.repositoryFullName, e.payloadHash, e.status)
    .run();
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
