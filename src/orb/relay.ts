// Orb event RELAY (#1255) — registration side. A brokered self-host registers its public relay URL so the central
// Orb can FORWARD its repos' webhook events to the container (which reviews + acts via brokered tokens). The
// container's enrollment secret is stored ENCRYPTED here (AES-256-GCM via TOKEN_ENCRYPTION_SECRET) so the Orb can
// HMAC-sign each forwarded event with it; the container verifies the signature with its own ORB_ENROLLMENT_SECRET.
// Per-enrollment isolation (one container's secret can never forge to another), and a DB-only leak can't forge
// (the encryption key is a separate secret).
import { hashToken } from "../auth/security";
import { githubWebhookCoalesceKey } from "../github/webhook-coalesce";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";
import type { GitHubWebhookPayload } from "../types";
import { decryptSecret, encryptSecret } from "../utils/crypto";

// The events a brokered container needs to review/act on. Installation-lifecycle + other Orb-internal events are
// deliberately NOT forwarded (the container runs under the CENTRAL Orb App, not its own, so it must not treat
// those as its own installation state).
// check_run is intentionally excluded: CI emits one per job per repo (thousands/day), making it a firehose that
// would flood self-host containers. check_suite fires once per push/PR sync and is sufficient — the engine
// re-reviews on suite completion (#1371: processors.ts handles both check_run and check_suite for that trigger,
// so dropping check_run here is lossless for brokered containers).
const RELAY_FORWARD_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_suite",
  "issue_comment",
  "issues",
]);

export type RelayForwardOutcome = "forwarded" | "queued" | "skipped" | "ignored" | "failed";

/** Events brokered self-host containers need for review/actuation (excludes CI firehose + install lifecycle). */
export function isRelayForwardableEvent(eventName: string): boolean {
  return RELAY_FORWARD_EVENTS.has(eventName);
}

/** A persisted `orb_relay_failures` row is terminal (delete) when delivery succeeded or the event can never be relayed. */
export function isRelayFailureRetryTerminal(outcome: RelayForwardOutcome, eventName: string): boolean {
  if (outcome === "forwarded" || outcome === "queued" || outcome === "ignored") return true;
  // Permanently non-forwardable (e.g. check_run removed from the allowlist) — the row is obsolete.
  if (outcome === "skipped" && !isRelayForwardableEvent(eventName)) return true;
  return false;
}

/** Whether a deferred forward attempt should INSERT into `orb_relay_failures` for the retry cron. */
export function shouldPersistRelayFailure(
  outcome: RelayForwardOutcome,
  eventName: string,
  installationId: number | null | undefined,
): boolean {
  if (installationId == null) return false;
  if (!isRelayForwardableEvent(eventName)) return false;
  // Push HTTP failure, or an already-enrolled relay that is temporarily undeliverable (no relay_url yet,
  // TOKEN_ENCRYPTION_SECRET absent during deploy, enrollment mid re-register). Terminal no-enrollment skips
  // are reported as "ignored" so raw webhook bodies are not retained for installs with no brokered relay.
  return outcome === "failed" || outcome === "skipped";
}

function logRelayTransientSkip(args: {
  deliveryId: string;
  eventName: string;
  installationId: number;
  phase: "initial" | "retry";
}): void {
  const message =
    args.phase === "initial"
      ? "Forwardable relay event skipped due to transient config — queued for retry cron"
      : "Forwardable relay event skipped due to transient config — retained in retry cron with backoff";
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "orb_relay_transient_skip",
      phase: args.phase,
      deliveryId: args.deliveryId,
      eventName: args.eventName,
      installationId: args.installationId,
      message,
    }),
  );
}

/** Record a deferred forward outcome that needs the retry cron (initial delivery path). Idempotent on delivery_id. */
export async function persistRelayForwardOutcome(
  env: Env,
  args: { deliveryId: string; eventName: string; installationId: number | null | undefined; rawBody: string },
  outcome: RelayForwardOutcome,
): Promise<void> {
  if (!shouldPersistRelayFailure(outcome, args.eventName, args.installationId)) return;
  await storeRelayFailure(env, {
    deliveryId: args.deliveryId,
    eventName: args.eventName,
    installationId: args.installationId!,
    rawBody: args.rawBody,
  });
  if (outcome === "skipped" && args.installationId != null) {
    logRelayTransientSkip({
      deliveryId: args.deliveryId,
      eventName: args.eventName,
      installationId: args.installationId,
      phase: "initial",
    });
  }
}

async function finalizeRelayFailureRetryRow(
  env: Env,
  row: { delivery_id: string; event_name: string; installation_id: number },
  outcome: RelayForwardOutcome,
): Promise<void> {
  if (isRelayFailureRetryTerminal(outcome, row.event_name)) {
    await env.DB.prepare("DELETE FROM orb_relay_failures WHERE delivery_id = ?").bind(row.delivery_id).run();
    return;
  }
  await env.DB
    .prepare("UPDATE orb_relay_failures SET attempts = attempts + 1, last_attempt_at = datetime('now') WHERE delivery_id = ?")
    .bind(row.delivery_id)
    .run();
  if (outcome === "skipped") {
    logRelayTransientSkip({
      deliveryId: row.delivery_id,
      eventName: row.event_name,
      installationId: row.installation_id,
      phase: "retry",
    });
  }
}

/** HMAC-SHA256 hex over the raw event body — the relay signature BOTH sides compute (the Orb with the decrypted
 *  enrollment secret, the container with its own ORB_ENROLLMENT_SECRET). Web Crypto (worker + node). */
export async function relaySignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Verify a relay signature (the `sha256=<hex>` value of x-orb-signature-256) over the body with `secret`, in
 *  CONSTANT TIME (crypto.subtle.verify). The container's relay receiver uses this with its ORB_ENROLLMENT_SECRET,
 *  so only the genuine Orb (which holds the encrypted copy of that secret) can drive it. */
export async function relayVerify(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header) return false;
  const hex = header.startsWith("sha256=") ? header.slice(7) : header;
  const sigBytes = hexToBytes(hex);
  if (!sigBytes) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  // sigBytes is always a plain (never shared) ArrayBuffer view — the cast only narrows the TYPE for the
  // UI workspace's stricter DOM-lib BufferSource, which excludes SharedArrayBuffer from ArrayBufferLike.
  return crypto.subtle.verify("HMAC", key, sigBytes as Uint8Array<ArrayBuffer>, new TextEncoder().encode(body));
}

export type RegisterResult =
  | { ok: true; installationId: number }
  | { error: "invalid_enrollment" | "installation_not_eligible" | "invalid_relay_url" | "encryption_unavailable" };

export const MAX_ORB_RELAY_REGISTER_BODY_BYTES = 4096;

function parseContentLength(header: string | null | undefined): number | null {
  if (typeof header !== "string") return null;
  const n = Number(header);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Read the relay-registration JSON with a small hard ceiling; returns null when the sender exceeds it OR when
 *  the underlying stream itself errors (a dropped connection / network reset mid-read, #orb-broker-500 — every
 *  caller already treats null identically to "reject this request", so a transient read failure degrades the
 *  same way an oversized payload does, instead of throwing UNCAUGHT out of this function. Each of this
 *  function's three route call sites (POST /v1/orb/token, /v1/orb/relay/register, /v1/orb/relay pull) calls it
 *  BEFORE its own try/catch, so an uncaught throw here previously escaped as a bare framework 500 instead of the
 *  route's own clean 4xx/503 JSON error response — fixed once here rather than wrapping all three callers. */
export async function readOrbRelayRegisterBody(request: Request, contentLengthHeader: string | null | undefined): Promise<string | null> {
  const declared = parseContentLength(contentLengthHeader);
  if (declared !== null && declared > MAX_ORB_RELAY_REGISTER_BODY_BYTES) return null;

  const stream = request.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ORB_RELAY_REGISTER_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  } catch {
    return null;
  }
}

export type RelayEnrollment = { enrollId: string; installationId: number };

export async function validateOrbRelayEnrollment(env: Env, secret: string): Promise<RelayEnrollment | { error: "invalid_enrollment" | "installation_not_eligible" }> {
  const row = await env.DB
    .prepare("SELECT enroll_id, installation_id, state, revoked_at FROM orb_enrollments WHERE secret_hash = ?")
    .bind(await hashToken(secret))
    .first<{ enroll_id: string; installation_id: number; state: string; revoked_at: string | null }>();
  if (!row || row.state !== "enrolled" || row.revoked_at !== null) return { error: "invalid_enrollment" };
  const install = await env.DB
    .prepare("SELECT registered, suspended_at, removed_at FROM orb_github_installations WHERE installation_id = ?")
    .bind(row.installation_id)
    .first<{ registered: number; suspended_at: string | null; removed_at: string | null }>();
  if (!install || install.registered !== 1 || install.suspended_at !== null || install.removed_at !== null) return { error: "installation_not_eligible" };
  return { enrollId: row.enroll_id, installationId: row.installation_id };
}

export async function registerValidatedOrbRelay(env: Env, enrollment: RelayEnrollment, secret: string, relayUrl: string, mode: "push" | "pull" = "push"): Promise<RegisterResult> {
  // Pull mode (#16): a tailnet container is never POSTed to, so there's no URL to SSRF-validate and no secret to
  // store for a forward-time HMAC (the engine authenticates its OWN outbound pull). Just flag the enrollment.
  if (mode === "pull") {
    await env.DB
      .prepare("UPDATE orb_enrollments SET relay_mode = 'pull', relay_registered_at = CURRENT_TIMESTAMP WHERE enroll_id = ?")
      .bind(enrollment.enrollId)
      .run();
    return { ok: true, installationId: enrollment.installationId };
  }
  // SSRF guard: the Orb will POST events to this URL — it must be a public https endpoint (no loopback / private /
  // link-local host), so a registered relay URL can never coerce the Orb into hitting an internal service.
  if (!isSafeHttpUrl(relayUrl)) return { error: "invalid_relay_url" };
  if (!env.TOKEN_ENCRYPTION_SECRET) return { error: "encryption_unavailable" };
  const enc = await encryptSecret(secret, env.TOKEN_ENCRYPTION_SECRET);
  // Set relay_mode='push' too so a re-register from a previously-pull enrollment flips back to push.
  await env.DB
    .prepare("UPDATE orb_enrollments SET relay_mode = 'push', relay_url = ?, relay_secret_enc = ?, relay_secret_iv = ?, relay_secret_salt = ?, relay_registered_at = CURRENT_TIMESTAMP WHERE enroll_id = ?")
    .bind(relayUrl, enc.ciphertext, enc.iv, enc.salt, enrollment.enrollId)
    .run();
  return { ok: true, installationId: enrollment.installationId };
}

/** Register (or update) the container's relay target for a valid enrollment. Validates the secret (→ the bound,
 *  registered, non-suspended install — same gate as the token broker), SSRF-validates the relay URL, then stores
 *  the URL + the enrollment secret encrypted at rest (for the forward-time HMAC). The container presents its OWN
 *  plaintext enrollment secret as the Bearer, so this is self-service + bound to that install. */
export async function registerOrbRelay(env: Env, secret: string, relayUrl: string, mode: "push" | "pull" = "push"): Promise<RegisterResult> {
  const enrollment = await validateOrbRelayEnrollment(env, secret);
  if ("error" in enrollment) return enrollment;
  return registerValidatedOrbRelay(env, enrollment, secret, relayUrl, mode);
}

const RELAY_RETRY_MAX_ATTEMPTS = 5;
const RELAY_RETRY_BATCH_SIZE = 25;
const RELAY_RETRY_CONCURRENCY = 5;
// Per-failure backoff (#1950): a row that just failed is not retried again until this window elapses, so a
// sustained outage does not re-attempt the whole failed-relay backlog on every ~2-min cron tick — which, fleet-wide,
// is a synchronized POST storm against the central Orb exactly when it is already degraded. Never-attempted rows
// (last_attempt_at IS NULL) stay immediately eligible, so a transient blip still recovers on the very next tick.
const RELAY_RETRY_BACKOFF_MINUTES = 5;

// Pull-mode relay (#16): a brokered self-host behind NAT/tailnet can't receive PUSHED forwards, so the Orb instead
// ENQUEUES its events here and the engine drains them outbound. The batch caps how many rows a single pull returns
// (and bounds the ack list), and the TTL drops events the engine never came back for (a long-down container).
const RELAY_PENDING_BATCH_SIZE = 50;
const RELAY_PENDING_TTL_HOURS = 24;
const RELAY_PENDING_MAX_PER_INSTALLATION = 500;

// #7523: 'kind' rides along on every pulled event so a self-host drain client can tell a config_push notice
// apart from a GitHub webhook BEFORE treating rawBody as a GitHubWebhookPayload — see
// src/selfhost/monitored-work.ts's drainOrbRelayWithMonitor.
export type RelayPendingEvent = { deliveryId: string; eventName: string; rawBody: string; kind: string };

// Bulk-delete drop logs (this function and retryFailedRelays below) sample at most this many rows' identifying
// info — an operator needs to see WHICH installation(s) lost events without a direct DB query, but a busy prune
// can span hundreds of rows, so the log payload itself must stay bounded.
const RELAY_DROP_LOG_SAMPLE_SIZE = 20;

/** Drop pull-mode rows that exceeded the raw-body retention window, even if their engine never polls. Exported
 *  (#7611 review fix) so a multi-target caller like the config-push route can prune ONCE per request instead of
 *  once per target -- see enqueueConfigPushRelay's own doc comment below for why it no longer prunes itself. */
export async function pruneRelayPending(env: Env): Promise<number> {
  // Sampled BEFORE the delete: a plain DELETE reports only a count, and the rows are unrecoverable once gone.
  // Same WHERE predicate as the delete below, capped so a large backlog can't inflate the log payload.
  const expiring = await env.DB
    .prepare(
      "SELECT delivery_id, event_name, installation_id FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours') ORDER BY created_at, delivery_id LIMIT ?",
    )
    .bind(RELAY_PENDING_TTL_HOURS, RELAY_DROP_LOG_SAMPLE_SIZE)
    .all<{ delivery_id: string; event_name: string; installation_id: number }>();
  const pruned = await env.DB
    .prepare("DELETE FROM orb_relay_pending WHERE created_at < datetime('now', '-' || ? || ' hours')")
    .bind(RELAY_PENDING_TTL_HOURS)
    .run();
  // Make pull-mode loss VISIBLE too (parity with the push-path drop): a pruned row is a webhook a long-down tailnet
  // container never drained — emit an alertable error-level log (distinct event name) so it leaves a Sentry trace.
  if (pruned.meta.changes > 0) {
    console.error(JSON.stringify({
      level: "error",
      event: "orb_relay_pending_dropped",
      message: `${pruned.meta.changes} pull-mode webhook(s) expired undrained after ${RELAY_PENDING_TTL_HOURS}h`,
      count: pruned.meta.changes,
      sample: expiring.results.map((r) => ({ deliveryId: r.delivery_id, eventName: r.event_name, installationId: r.installation_id })),
    }));
  }
  return pruned.meta.changes;
}

/** Enqueue a pull-mode event for an installation. Idempotent on delivery_id (mirrors storeRelayFailure) — a GitHub
 *  redelivery reaching the Orb twice never double-queues. Prunes expired rows and caps each install's backlog first so
 *  an offline/malicious pull enrollment cannot retain raw webhook bodies indefinitely. */
export async function enqueueRelayPending(
  env: Env,
  args: { deliveryId: string; installationId: number; eventName: string; rawBody: string },
): Promise<void> {
  await pruneRelayPending(env);
  const coalesceKey = relayPendingCoalesceKey(args.eventName, args.rawBody);
  const inserted = await env.DB
    .prepare(
      "INSERT INTO orb_relay_pending (delivery_id, installation_id, event_name, raw_body, coalesce_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING",
    )
    .bind(args.deliveryId, args.installationId, args.eventName, args.rawBody, coalesceKey)
    .run();
  if (coalesceKey && inserted.meta.changes > 0) {
    await env.DB
      .prepare(
        `DELETE FROM orb_relay_pending
         WHERE installation_id = ?
           AND coalesce_key = ?
           AND rowid < (SELECT rowid FROM orb_relay_pending WHERE delivery_id = ?)`,
      )
      .bind(args.installationId, coalesceKey, args.deliveryId)
      .run();
  }
  await env.DB
    .prepare(
      `DELETE FROM orb_relay_pending
       WHERE installation_id = ?
         AND delivery_id IN (
           SELECT delivery_id FROM orb_relay_pending
           WHERE installation_id = ?
           ORDER BY created_at DESC, delivery_id DESC
           LIMIT -1 OFFSET ?
         )`,
    )
    .bind(args.installationId, args.installationId, RELAY_PENDING_MAX_PER_INSTALLATION)
    .run();
}

export type ConfigPushPayload = {
  pushId: string;
  message: string;
  capability?: string | undefined;
  deprecatesAt?: string | undefined;
};

/** An Orb-operational notice (#7522, piece 1 of #4902's 3-piece design) addressed to one installation — NOT a
 *  GitHub webhook, so unlike enqueueRelayPending above this skips coalesce-key derivation entirely (that logic
 *  assumes `rawBody` parses as a GitHubWebhookPayload; a config_push payload never does). Still shares the same
 *  pending queue as the webhook path — same per-installation backlog cap — since both kinds drain through the
 *  same pull loop (`kind` is how the drain side, #7523, tells them apart before touching `rawBody`).
 *  `deliveryId` is derived from `pushId` + `installationId` (not caller-supplied) so re-posting the same push
 *  is idempotent per target, matching every other ON CONFLICT DO NOTHING write in this file.
 *
 *  Deliberately does NOT prune here (#7611 review fix): enqueueRelayPending prunes per-call because it's
 *  invoked once per individually-arriving webhook, but this function is fanned out over up to 500
 *  `installationIds` from a SINGLE request (POST /v1/app/fleet/config-push) — pruning inside it would turn one
 *  request into up to 500 redundant global TTL-prune scans/deletes against the shared table. The caller prunes
 *  ONCE before the fan-out instead (see that route's own handler). */
export async function enqueueConfigPushRelay(env: Env, installationId: number, payload: ConfigPushPayload): Promise<void> {
  const deliveryId = `config-push:${payload.pushId}:${installationId}`;
  await env.DB
    .prepare(
      "INSERT INTO orb_relay_pending (delivery_id, installation_id, event_name, raw_body, kind) VALUES (?, ?, 'config_push', ?, 'config_push') ON CONFLICT(delivery_id) DO NOTHING",
    )
    .bind(deliveryId, installationId, JSON.stringify(payload))
    .run();
  await env.DB
    .prepare(
      `DELETE FROM orb_relay_pending
       WHERE installation_id = ?
         AND delivery_id IN (
           SELECT delivery_id FROM orb_relay_pending
           WHERE installation_id = ?
           ORDER BY created_at DESC, delivery_id DESC
           LIMIT -1 OFFSET ?
         )`,
    )
    .bind(installationId, installationId, RELAY_PENDING_MAX_PER_INSTALLATION)
    .run();
}

function relayPendingCoalesceKey(eventName: string, rawBody: string): string | null {
  try {
    return githubWebhookCoalesceKey(
      eventName,
      JSON.parse(rawBody) as GitHubWebhookPayload,
    );
  } catch {
    return null;
  }
}

/** Drain pending pull-mode events for an installation. The engine calls this outbound (it can't be pushed to):
 *  1) prune TTL-expired rows fleet-wide, 2) delete rows the caller ACKs (scoped to this install so one container
 *  can never ack another's), then 3) return the next ordered batch. `ack` and `limit` are both capped at the batch
 *  size to bound the SQL and the response. */
export async function pullRelayPending(
  env: Env,
  installationId: number,
  opts?: { ack?: string[] | undefined; limit?: number | undefined },
): Promise<RelayPendingEvent[]> {
  // Prune rows the engine never came back for (same datetime() comparison style as retryFailedRelays).
  await pruneRelayPending(env);

  const ack = opts?.ack?.slice(0, RELAY_PENDING_BATCH_SIZE) ?? [];
  if (ack.length) {
    const placeholders = ack.map(() => "?").join(", ");
    await env.DB
      .prepare(`DELETE FROM orb_relay_pending WHERE installation_id = ? AND delivery_id IN (${placeholders})`)
      .bind(installationId, ...ack)
      .run();
  }

  // SQLite interprets LIMIT -1 as "unbounded", so non-positive/non-integer values must
  // fall back to the default batch size instead of passing through verbatim.
  const requested = opts?.limit;
  const requestedLimit =
    typeof requested === "number" && Number.isInteger(requested) && requested > 0
      ? requested
      : RELAY_PENDING_BATCH_SIZE;
  const limit = Math.min(requestedLimit, RELAY_PENDING_BATCH_SIZE);
  const { results } = await env.DB
    .prepare("SELECT delivery_id, event_name, raw_body, kind FROM orb_relay_pending WHERE installation_id = ? ORDER BY created_at, delivery_id LIMIT ?")
    .bind(installationId, limit)
    .all<{ delivery_id: string; event_name: string; raw_body: string; kind: string }>();
  return results.map((r) => ({ deliveryId: r.delivery_id, eventName: r.event_name, rawBody: r.raw_body, kind: r.kind }));
}

/** Record a failed relay forward in the retry queue. Idempotent on delivery_id — a duplicate insert (e.g. from a
 *  GitHub redelivery reaching the same event before the retry fires) is silently ignored. */
export async function storeRelayFailure(
  env: Env,
  args: { deliveryId: string; eventName: string; installationId: number; rawBody: string },
): Promise<void> {
  await env.DB
    .prepare(
      "INSERT INTO orb_relay_failures (delivery_id, event_name, installation_id, raw_body) VALUES (?, ?, ?, ?) ON CONFLICT(delivery_id) DO NOTHING",
    )
    .bind(args.deliveryId, args.eventName, args.installationId, args.rawBody)
    .run();
}

/** Re-attempt pending relay failures. Called by the `retry-orb-relay` cron job every sweep cycle (≈2 min).
 *  Each row gets up to RELAY_RETRY_MAX_ATTEMPTS (5) retries within a 1-hour TTL; on success or expiry the row
 *  is removed. Never throws — a bad DB row or a persistently-down container is dropped (with an alertable log,
 *  below) after exhaustion. */
export async function retryFailedRelays(env: Env, opts?: { fetchImpl?: typeof fetch }): Promise<void> {
  // Prune rows whose TTL has elapsed or whose attempt budget is exhausted. Sampled BEFORE the delete (see
  // pruneRelayPending above) so the drop log can name WHICH events were given up on.
  const expiring = await env.DB
    .prepare(
      "SELECT delivery_id, event_name, installation_id FROM orb_relay_failures WHERE expires_at < datetime('now') OR attempts >= ? ORDER BY created_at, delivery_id LIMIT ?",
    )
    .bind(RELAY_RETRY_MAX_ATTEMPTS, RELAY_DROP_LOG_SAMPLE_SIZE)
    .all<{ delivery_id: string; event_name: string; installation_id: number }>();
  const pruned = await env.DB
    .prepare("DELETE FROM orb_relay_failures WHERE expires_at < datetime('now') OR attempts >= ?")
    .bind(RELAY_RETRY_MAX_ATTEMPTS)
    .run();
  // Make the drop VISIBLE (#5): a pruned row is a relay event we gave up delivering (1-hour TTL elapsed or 5
  // retries exhausted) — e.g. a container down for over an hour. Emit an alertable structured log so the loss
  // leaves a trace instead of vanishing silently.
  if (pruned.meta.changes > 0) {
    console.error(JSON.stringify({
      level: "error",
      event: "orb_relay_events_dropped",
      message: `${pruned.meta.changes} relay event(s) dropped after ${RELAY_RETRY_MAX_ATTEMPTS} retries or 1h TTL`,
      count: pruned.meta.changes,
      sample: expiring.results.map((r) => ({ deliveryId: r.delivery_id, eventName: r.event_name, installationId: r.installation_id })),
    }));
  }
  // Skip rows still inside their per-failure backoff window (#1950): a row whose last attempt was under
  // RELAY_RETRY_BACKOFF_MINUTES ago waits for a later tick, so a down container is not re-POSTed every ~2 min.
  // The bound modifier keeps this portable (the pg-dialect rewrites datetime('now', ?) → now() + (?)::interval).
  const { results } = await env.DB
    .prepare(
      "SELECT delivery_id, event_name, installation_id, raw_body FROM orb_relay_failures WHERE expires_at >= datetime('now') AND attempts < ? AND (last_attempt_at IS NULL OR last_attempt_at <= datetime('now', ?)) ORDER BY created_at, delivery_id LIMIT ?",
    )
    .bind(RELAY_RETRY_MAX_ATTEMPTS, `-${RELAY_RETRY_BACKOFF_MINUTES} minutes`, RELAY_RETRY_BATCH_SIZE)
    .all<{ delivery_id: string; event_name: string; installation_id: number; raw_body: string }>();
  if (!results.length) return;

  const retryRow = async (row: { delivery_id: string; event_name: string; installation_id: number; raw_body: string }) => {
    const outcome = await forwardOrbEvent(
      env,
      { eventName: row.event_name, installationId: row.installation_id, deliveryId: row.delivery_id, rawBody: row.raw_body },
      opts?.fetchImpl,
    );
    await finalizeRelayFailureRetryRow(env, row, outcome);
  };

  for (let i = 0; i < results.length; i += RELAY_RETRY_CONCURRENCY) {
    await Promise.all(results.slice(i, i + RELAY_RETRY_CONCURRENCY).map(retryRow));
  }
}

/** Forward a webhook event to the brokered self-host registered for this installation. BEST-EFFORT + fail-safe:
 *  a non-forwardable event, no registered relay, or ANY error returns without throwing (the Orb's webhook 202
 *  stands; reliability hardening — a retry queue for a down container — is a follow-up). The body is HMAC-signed
 *  with the container's enrollment secret (decrypted from the stored ciphertext); the container verifies with its
 *  own ORB_ENROLLMENT_SECRET, so only the genuine Orb can drive it. */
export async function forwardOrbEvent(
  env: Env,
  args: { eventName: string; installationId: number | null | undefined; deliveryId: string; rawBody: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RelayForwardOutcome> {
  if (!args.installationId || !RELAY_FORWARD_EVENTS.has(args.eventName)) return "skipped";
  // issueOrbEnrollment INSERTs a new row per enrollment without revoking prior enrolled rows for the same
  // installation_id. Without ORDER BY, .first() is nondeterministic — a stale row (no relay / old URL) can win
  // after re-enrollment (#1783). Prefer enrollments with a registered relay (SQLite sorts NULL first on DESC),
  // then the newest relay registration, then the newest enrollment. The final tie-break is the implicit rowid
  // (monotonic insertion order) — enroll_id is a random opaque token, and CURRENT_TIMESTAMP ties at second
  // resolution, so rowid is the only stable "most recently inserted" key when those collide (#1783).
  const row = await env.DB
    .prepare(
      "SELECT relay_mode, relay_url, relay_secret_enc, relay_secret_iv, relay_secret_salt FROM orb_enrollments WHERE installation_id = ? AND state = 'enrolled' AND revoked_at IS NULL ORDER BY (relay_registered_at IS NOT NULL) DESC, relay_registered_at DESC, enrolled_at DESC, rowid DESC",
    )
    .bind(args.installationId)
    .first<{ relay_mode: string; relay_url: string | null; relay_secret_enc: string | null; relay_secret_iv: string | null; relay_secret_salt: string | null }>();
  if (!row) return "ignored"; // not a brokered self-host (or revoked) — nothing to relay to
  // Pull mode (#16): a tailnet container can't be pushed to, so ENQUEUE the event for it to drain outbound.
  if (row.relay_mode === "pull") {
    await enqueueRelayPending(env, { deliveryId: args.deliveryId, installationId: args.installationId, eventName: args.eventName, rawBody: args.rawBody });
    return "queued";
  }
  // Push mode with nothing registered (relay_url null) or no decryption key → skip. relay_secret_enc/iv are written
  // atomically with relay_url at registration, so they're non-null whenever relay_url is (asserted below).
  if (!row.relay_url || !env.TOKEN_ENCRYPTION_SECRET) return "skipped";
  try {
    const secret = await decryptSecret(row.relay_secret_enc!, row.relay_secret_iv!, env.TOKEN_ENCRYPTION_SECRET, row.relay_secret_salt);
    const signature = await relaySignature(secret, args.rawBody);
    const res = await fetchImpl(row.relay_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": args.eventName,
        "x-github-delivery": args.deliveryId,
        "x-orb-signature-256": `sha256=${signature}`,
        "user-agent": "loopover-orb/0.1",
      },
      body: args.rawBody,
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? "forwarded" : "failed";
  } catch {
    return "failed"; // a down / unreachable container (or a decrypt/sign error) must never fail the Orb's 202
  }
}
