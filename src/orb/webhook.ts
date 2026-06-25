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

  await recordOrbWebhookEvent(c.env, {
    deliveryId,
    eventName,
    action: payload.action ?? null,
    installationId: payload.installation?.id ?? null,
    repositoryFullName: payload.repository?.full_name ?? null,
    payloadHash,
  });

  return c.json({ ok: true, deliveryId, eventName, status: "received" }, 202);
}

async function getOrbWebhookEvent(env: Env, deliveryId: string): Promise<{ payloadHash: string; status: string } | null> {
  const row = await env.DB.prepare("SELECT payload_hash AS payloadHash, status FROM orb_webhook_events WHERE delivery_id = ?")
    .bind(deliveryId)
    .first<{ payloadHash: string; status: string }>();
  return row ?? null;
}

async function recordOrbWebhookEvent(
  env: Env,
  e: { deliveryId: string; eventName: string; action: string | null; installationId: number | null; repositoryFullName: string | null; payloadHash: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orb_webhook_events (delivery_id, event_name, action, installation_id, repository_full_name, payload_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, 'received')
     ON CONFLICT(delivery_id) DO UPDATE SET
       status = 'received', payload_hash = excluded.payload_hash, action = excluded.action,
       installation_id = excluded.installation_id, repository_full_name = excluded.repository_full_name`,
  )
    .bind(e.deliveryId, e.eventName, e.action, e.installationId, e.repositoryFullName, e.payloadHash)
    .run();
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
