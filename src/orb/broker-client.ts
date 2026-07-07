// Self-host BROKER CLIENT (#1255). A self-hosted engine exchanges its operator-issued enrollment secret for a
// short-lived GitHub installation token from the central Orb (POST /v1/orb/token), so it can act on its own repos
// WITHOUT ever holding a GitHub App private key (gittensory holds the Orb App key centrally and mints on demand —
// the das-github-mirror model). Used by createInstallationToken in broker mode; the installation-token CACHE lives
// with the App-key path in src/github/app.ts (one mint per ~hour per installation, broker or local).
//
// The signal is the ENROLLMENT SECRET's presence: a brokered self-host sets ORB_ENROLLMENT_SECRET (issued by the
// operator), cloud never does — so this path is inert on cloud and the deploy is byte-identical there.

import { incr } from "../selfhost/metrics";

/** The Orb's hosted broker base; override (ORB_BROKER_URL) only to point at a private gittensory deployment. */
const DEFAULT_BROKER_URL = "https://gittensory-api.aethereal.dev";
// The broker's cold token mint can take many seconds when GitHub is throttling the App; allow headroom so the one
// uncached mint completes and populates the broker-side cache (steady-state cache hits return in well under a second).
const BROKER_TIMEOUT_MS = 25_000;
// Relay registration hits the same broker under the same load conditions as token minting; mirror BROKER_TIMEOUT_MS
// so a loaded broker (e.g. at boot time with concurrent token-mint demand) doesn't abort registration prematurely.
const ORB_RELAY_REGISTER_TIMEOUT_MS = 25_000;

function isLocalBrokerHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || (hostname === "::1" || hostname === "[::1]");
}

function orbBrokerBaseUrl(env: { ORB_BROKER_URL?: string | undefined }): string {
  const raw = env.ORB_BROKER_URL ?? DEFAULT_BROKER_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ORB_BROKER_URL must be a valid URL.");
  }
  if (url.username || url.password) {
    throw new Error("ORB_BROKER_URL must not include userinfo.");
  }
  if (url.search || url.hash) {
    throw new Error("ORB_BROKER_URL must not include a query string or fragment.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalBrokerHost(url.hostname))) {
    throw new Error("ORB_BROKER_URL must use https unless it targets localhost development.");
  }
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** True when GitHub tokens should be sourced from the central Orb broker (a brokered self-host) rather than minted
 *  locally from an App key — i.e. an enrollment secret is configured. Cloud never sets it ⇒ false there. */
export function isOrbBrokerMode(env: { ORB_ENROLLMENT_SECRET?: string | undefined }): boolean {
  return Boolean(env.ORB_ENROLLMENT_SECRET);
}

export type BrokeredInstallationToken = { token: string; installationId: number; expiresAtMs: number; permissions: Record<string, string> };

/** Exchange the enrollment secret for a brokered installation token + its expiry (ms epoch). Throws on a non-OK
 *  response (401 invalid_enrollment / 403 installation_not_eligible / 5xx) or a tokenless body — a brokered
 *  self-host holds no App key to fall back to, so a mint failure is fatal for that request exactly like the
 *  App-key path, and the queue's existing retry/dead-letter handling covers a transient broker outage. */
export async function fetchBrokeredInstallationToken(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined },
  fetchImpl: typeof fetch = fetch,
  options: { forceRefresh?: boolean } = {},
): Promise<BrokeredInstallationToken> {
  const base = orbBrokerBaseUrl(env);
  const response = await fetchImpl(`${base}/v1/orb/token`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET ?? ""}`,
      ...(options.forceRefresh ? { "content-type": "application/json" } : {}),
    },
    ...(options.forceRefresh ? { body: JSON.stringify({ forceRefresh: true }) } : {}),
    signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Orb broker token exchange failed (${response.status}).`);
  }
  const payload = (await response.json()) as { token?: string; installationId?: number; expiresAt?: string; permissions?: Record<string, string> };
  if (!payload.token) {
    throw new Error("Orb broker token response did not include a token.");
  }
  // A present-but-unparseable expiresAt must fall back like an absent one: Date.parse → NaN would otherwise
  // propagate into the installation-token cache, where `cached.expiresAtMs - margin > Date.now()` is always
  // false for NaN — re-minting a brokered token on every GitHub call instead of caching it for ~an hour.
  const parsedExpiry = payload.expiresAt ? Date.parse(payload.expiresAt) : Number.NaN;
  const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 50 * 60_000;
  return { token: payload.token, installationId: payload.installationId ?? 0, expiresAtMs, permissions: payload.permissions ?? {} };
}

// Diagnosing a broker register failure (#selfhost-runtime-drift) needs more than a bare status code, but the
// response body is attacker/operator-adjacent (the broker, or anything on-path to it) and must never be logged
// verbatim. Only a short, structured hint is ever surfaced: a JSON body's own `error`/`message` string field,
// bounded in length -- never raw bytes/headers, so there is nothing here for a secret to hide inside.
const ORB_RELAY_REGISTER_ERROR_BODY_MAX_BYTES = 2_000;
const ORB_RELAY_REGISTER_ERROR_HINT_MAX_CHARS = 200;

async function boundedResponseText(res: Response, maxBytes: number): Promise<string | undefined> {
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.body) return undefined;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - received;
      const chunk = value.length > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.length;
      if (value.length > remaining || received >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (received === 0) return undefined;
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function safeOrbRelayRegisterErrorHint(res: Response): Promise<string | undefined> {
  try {
    const text = await boundedResponseText(res, ORB_RELAY_REGISTER_ERROR_BODY_MAX_BYTES);
    if (!text) return undefined;
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const hint = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
    return hint ? hint.slice(0, ORB_RELAY_REGISTER_ERROR_HINT_MAX_CHARS) : undefined;
  } catch {
    return undefined; // non-JSON / unreadable body — the status code alone still carries the failure
  }
}

/** Self-register this container's PUBLIC relay URL with the central Orb on boot, so the Orb forwards this install's
 *  events to us (the event half of brokered review). BEST-EFFORT: skipped unless broker mode + a public origin are
 *  configured, and any failure (Orb down, install not registered yet, non-public origin rejected) just means no
 *  relay until the next boot — it never blocks startup or throws. The relay URL is the container's public origin +
 *  /v1/orb/relay (the receiver); the Orb SSRF-validates it, so PUBLIC_API_ORIGIN must be a real public https host. */
export async function registerOrbRelayTarget(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined; PUBLIC_API_ORIGIN?: string | undefined; ORB_RELAY_MODE?: string | undefined },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "registered" | "skipped" | "failed"; reason?: string }> {
  if (!isOrbBrokerMode(env)) return { status: "skipped" };
  // Pull mode (#secure-relay): the engine DRAINS events outbound from the Orb, so NO inbound endpoint is exposed —
  // the right fit for a NAT/tailnet self-host (a public push URL would otherwise be unreachable). Push mode needs a
  // public relay URL the Orb can reach.
  const mode = env.ORB_RELAY_MODE === "pull" ? "pull" : "push";
  if (mode === "push" && !env.PUBLIC_API_ORIGIN) return { status: "skipped" };
  const relayUrl = mode === "push" ? `${env.PUBLIC_API_ORIGIN!.replace(/\/+$/, "")}/v1/orb/relay` : "";
  try {
    const base = orbBrokerBaseUrl(env);
    const res = await fetchImpl(`${base}/v1/orb/relay/register`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET}`, "content-type": "application/json" }, // present — isOrbBrokerMode required it
      body: JSON.stringify({ relayUrl, mode }),
      signal: AbortSignal.timeout(ORB_RELAY_REGISTER_TIMEOUT_MS),
    });
    if (res.ok) return { status: "registered" };
    // Carry WHY it failed (HTTP status + an optional sanitized hint) so the caller's log — and Sentry — show a
    // real reason, not "(no message)".
    const hint = await safeOrbRelayRegisterErrorHint(res);
    return { status: "failed", reason: hint ? `http_${res.status}: ${hint}` : `http_${res.status}` };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "fetch_threw",
    };
  }
}

// `attempts` (below) is a lifetime total, never reset -- it answers "did this recover after prior
// failures" (see registerOrbRelayWithMonitor) but can't tell "is it CURRENTLY stuck" from "it hiccuped
// once years ago". `consecutiveFailures` is the complementary streak: it resets to 0 on any success, so
// only a SUSTAINED run of back-to-back failures grows it -- the same shape as ai.ts's
// `aiConsecutiveFailures` / `AI_UNHEALTHY_FAILURE_STREAK`.
export type OrbRelayRegistrationState = { registered: boolean; lastAttemptAtMs: number | null; attempts: number; consecutiveFailures: number };

export function createOrbRelayRegistrationState(): OrbRelayRegistrationState {
  return { registered: false, lastAttemptAtMs: null, attempts: 0, consecutiveFailures: 0 };
}

// Mirrors AI_UNHEALTHY_FAILURE_STREAK's shape (src/selfhost/ai.ts): one bad registration attempt is
// routine (the broker had a slow tick, a deploy in flight, a momentary network blip) and must not alert
// on its own -- only a SUSTAINED run of consecutive failures indicates the broker link is actually
// stuck rather than just having hiccuped once (#selfhost-runtime-drift follow-up).
export const ORB_RELAY_REGISTER_UNHEALTHY_FAILURE_STREAK = 3;

// Mirrors RELAY_RETRY_BACKOFF_MINUTES (src/orb/relay.ts) for the same reason: a sustained broker outage must not
// re-attempt registration on every ~1min tick -- fleet-wide, that is a synchronized retry storm against a
// central Orb that is already degraded.
export const ORB_RELAY_REGISTER_RETRY_BACKOFF_MS = 5 * 60_000;

/** Stateful retry wrapper around {@link registerOrbRelayTarget} (#selfhost-runtime-drift): a one-shot boot-time
 *  registration that never retries leaves a container permanently deaf to its relay after a single transient
 *  broker 500 -- the ONLY way it recovers is a process restart. Call this on a recurring timer (e.g. every
 *  minute) instead: it no-ops once registered, and otherwise re-attempts at most once per
 *  {@link ORB_RELAY_REGISTER_RETRY_BACKOFF_MS} so a persistent outage degrades to a bounded, sane retry rate
 *  rather than spamming the broker. `state` is mutated in place so the caller can hold one instance for the
 *  process lifetime. */
export async function registerOrbRelayTargetWithRetry(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined; PUBLIC_API_ORIGIN?: string | undefined; ORB_RELAY_MODE?: string | undefined },
  state: OrbRelayRegistrationState,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: "registered" | "already_registered" | "skipped" | "backoff" | "failed"; reason?: string }> {
  if (!isOrbBrokerMode(env)) return { status: "skipped" };
  if (state.registered) return { status: "already_registered" };
  if (state.lastAttemptAtMs !== null && nowMs - state.lastAttemptAtMs < ORB_RELAY_REGISTER_RETRY_BACKOFF_MS) {
    return { status: "backoff" };
  }
  state.lastAttemptAtMs = nowMs;
  state.attempts += 1;
  const result = await registerOrbRelayTarget(env, fetchImpl);
  if (result.status === "skipped") return { status: "skipped" }; // intentional no-op, not a broker failure -- leaves the streak untouched
  if (result.status === "registered") {
    state.registered = true;
    state.consecutiveFailures = 0;
    return { status: "registered" };
  }
  state.consecutiveFailures += 1;
  /* v8 ignore next -- registerOrbRelayTarget's own "failed" returns always set a string reason (http_NNN or an
   * error message); the undefined arm only satisfies exactOptionalPropertyTypes for the shared result shape. */
  return result.reason !== undefined ? { status: "failed", reason: result.reason } : { status: "failed" };
}

/** Pull-mode drain (#secure-relay): fetch this install's queued events from the Orb, acking the previous batch's
 *  delivery ids so the Orb deletes them. Lets a NAT/tailnet engine receive events WITHOUT exposing an inbound
 *  endpoint. BEST-EFFORT at the scheduler boundary — returns [] only when broker mode is off, and throws
 *  on broker communication failures so monitoring does not record false drain progress. */
export async function drainOrbRelay(
  env: { ORB_ENROLLMENT_SECRET?: string | undefined; ORB_BROKER_URL?: string | undefined },
  ack: string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<{ deliveryId: string; eventName: string; rawBody: string }[]> {
  if (!isOrbBrokerMode(env)) return [];
  try {
    const base = orbBrokerBaseUrl(env);
    const res = await fetchImpl(`${base}/v1/orb/relay/pull`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ORB_ENROLLMENT_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ ack }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`orb_relay_drain_http_${res.status}`);
    const body = (await res.json()) as { events?: Array<{ deliveryId?: unknown; eventName?: unknown; rawBody?: unknown }> };
    const out: { deliveryId: string; eventName: string; rawBody: string }[] = [];
    for (const e of body.events ?? []) {
      if (typeof e.deliveryId === "string" && typeof e.eventName === "string" && typeof e.rawBody === "string") {
        out.push({ deliveryId: e.deliveryId, eventName: e.eventName, rawBody: e.rawBody });
        continue;
      }
      // #zero-trace-webhook-loss: a batch entry missing/mistyping one of the three required fields was
      // previously discarded with no record anywhere — indistinguishable from the Orb never having relayed it.
      incr("gittensory_orb_relay_malformed_events_total");
      console.error(
        JSON.stringify({
          level: "error",
          event: "orb_relay_malformed_event_dropped",
          hasDeliveryId: typeof e.deliveryId === "string",
          hasEventName: typeof e.eventName === "string",
          hasRawBody: typeof e.rawBody === "string",
        }),
      );
    }
    return out;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("orb_relay_drain_failed");
  }
}
