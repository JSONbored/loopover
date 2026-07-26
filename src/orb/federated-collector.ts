// LoopOver federated fleet intelligence (#1970) — OPT-IN collector TRANSPORT client (#6479).
//
// Moves the anonymized bundles built by ./federated-bundle.ts (#6478) between self-hosted instances. Two
// directions, both best-effort and both off by default:
//   push — POST this instance's own bundle to the operator's configured collector.
//   pull — GET peer bundles from it.
//
// SCOPE — deliberately NOT the import side. A pulled bundle is fetched, shape-checked and RETURNED; it is
// never signature-verified, never trust-gated, and never persisted. That is #6480's job, which SHIPPED
// separately in ./federated-import.ts: it trust-gates each bundle against the operator's
// `federatedIntelligence.peerKeys` allowlist per #6477's ratified key-trust/anti-poisoning design. Verifying
// HERE would still be wrong — the trust anchor lives with the importer that decides what to fold in, not with
// the transport client that only fetches (see the KEY-TRUST note on signFederatedBundle in ./federated-bundle.ts).
//
// NO DEFAULT COLLECTOR, BY DESIGN. The client only ever talks to an endpoint the operator configured in
// `.loopover.yml`. There is no hardcoded fallback and no auto-discovery — this codebase's self-host posture
// assumes no central/managed collector exists. (Contrast the #1255 orb path, which does POST to a hosted
// default at src/selfhost/orb-collector.ts:168; that is a different feature with a different contract.)
//
// FAIL-SAFE, ALWAYS. Every entry point resolves the opt-in BEFORE touching the database or the network, wraps
// its whole body in a catch, and degrades to a falsy result. Nothing here throws, so the review/gate path can
// never be slowed or broken by a collector that is unreachable, slow, rate-limited or returning garbage. The
// gate never awaits this; it is background, best-effort sync.
import {
  evaluateLocalRateLimit,
  jitteredBackoffMs,
  type LocalRateBucket,
} from "@loopover/engine";
import { isSafeHttpUrl } from "../review/content-lane/safe-url";
import { buildFederatedBundle, FEDERATED_BUNDLE_SCHEMA_VERSION, type FederatedSignalBundle } from "./federated-bundle";
import type { FocusManifest } from "../signals/focus-manifest";

/** Matches every other outbound call in this subsystem (orb-collector.ts:215's 30s export tick). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Total attempts per direction, including the first. Mirrors the miner's fetchWithRetry contract. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** Exponential base for the jittered backoff between retries. */
const RETRY_BASE_MS = 500;
/** A best-effort background sync has no business hammering a peer's collector. */
const RATE_LIMIT: { limit: number; windowMs: number } = { limit: 6, windowMs: 60_000 };

type ManifestSlice = Pick<FocusManifest, "federatedIntelligence"> | null | undefined;

export type CollectorOpts = {
  /** Injected so tests never touch the real network (orb-collector.ts:155's fetchFn idiom). */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injected so a retry costs no wall-clock in tests. */
  sleepFn?: (ms: number) => Promise<unknown>;
  /** Injected random for the jitter — jitteredBackoffMs never reads Math.random itself. */
  randomFn?: () => number;
  /** Caller-owned rolling-window bucket. Omitted ⇒ no local rate limiting is applied. */
  bucket?: LocalRateBucket;
  now?: number;
};

/**
 * The collector endpoint armed for `direction`, or null when this instance must not talk to anyone: not opted
 * in, no collector configured, the configured URL failed the SSRF guard at parse time, or the operator scoped
 * `collectorMode` to the other direction. Callers MUST consult this before touching the network or the DB.
 */
export function resolveCollectorEndpoint(manifest: ManifestSlice, direction: "push" | "pull"): string | null {
  const config = manifest?.federatedIntelligence;
  if (config?.enabled !== true) return null;
  const url = config.collectorUrl;
  if (url === null || url === undefined) return null;
  // Defense in depth: the URL was already guarded at config-read time, but re-check at call time exactly as
  // src/orb/relay.ts:230 does — a snapshot round-tripped through KV must not be trusted to have been parsed
  // by the current guard.
  if (!isSafeHttpUrl(url)) return null;
  const mode = config.collectorMode ?? "both";
  if (mode !== "both" && mode !== direction) return null;
  return url;
}

/** True when the caller's bucket still permits an attempt. No bucket ⇒ unlimited. */
function rateLimitAllows(opts: CollectorOpts, now: number): boolean {
  if (!opts.bucket) return true;
  return evaluateLocalRateLimit(opts.bucket, RATE_LIMIT, now).allowed;
}

/** A 4xx is the operator's own misconfiguration and will fail identically on a retry; only 5xx/network is
 *  worth another attempt. Mirrors packages/loopover-miner/lib/http-retry.js's 5xx-only contract. */
function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

/**
 * One fetch with a bounded timeout, retried on 5xx/network with jittered exponential backoff. Returns the
 * Response on a 2xx, or null once attempts are exhausted / a non-retryable status arrives. Never throws.
 */
async function fetchWithRetry(url: string, init: RequestInit, opts: CollectorOpts): Promise<Response | null> {
  const doFetch = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? Math.max(1, opts.maxAttempts as number) : DEFAULT_MAX_ATTEMPTS;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.randomFn ?? Math.random;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      // A 4xx is the operator's own misconfiguration and will fail identically next time.
      if (!isRetryableStatus(response.status)) return null;
    } catch {
      // A timeout, DNS failure or connection reset — indistinguishable to us, and all worth one more try.
    }
    if (attempt === maxAttempts - 1) return null;
    await sleep(jitteredBackoffMs(RETRY_BASE_MS, attempt, random));
  }
  /* v8 ignore next -- unreachable: maxAttempts is clamped to >= 1, so the final iteration always returns above */
  return null;
}

/** Is this parsed value a bundle we understand? Shape only — NOT a signature/trust check (#6477/#6480). */
function isBundleShaped(value: unknown): value is FederatedSignalBundle {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    b.schemaVersion === FEDERATED_BUNDLE_SCHEMA_VERSION &&
    typeof b.instanceId === "string" &&
    typeof b.generatedAt === "string" &&
    typeof b.windowDays === "number" &&
    typeof b.decided === "number" &&
    typeof b.signature === "string"
  );
}

/**
 * Push this instance's own bundle to the operator's configured collector.
 *
 * Returns false — having touched neither the database nor the network — unless the operator opted in AND
 * configured a push-armed collector. Returns false rather than throwing on any failure. The body is exactly
 * the anonymized bundle from #6478: no code, no diffs, no logins, no repo names.
 */
export async function pushFederatedBundle(manifest: ManifestSlice, db: D1Database, opts: CollectorOpts = {}): Promise<boolean> {
  const endpoint = resolveCollectorEndpoint(manifest, "push");
  if (endpoint === null) return false;

  try {
    const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
    if (!rateLimitAllows(opts, now)) return false;

    const bundle = await buildFederatedBundle(manifest, db, opts.now === undefined ? {} : { now: opts.now });
    // The builder already fails safe to null; nothing to send is not a failure worth retrying.
    if (bundle === null) return false;

    const response = await fetchWithRetry(
      endpoint,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) },
      opts,
    );
    return response !== null;
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", event: "federated_push_failed", message: String(error).slice(0, 200) }),
    );
    return false;
  }
}

/**
 * Pull peer bundles from the operator's configured collector.
 *
 * Returns [] — having touched nothing — unless the operator opted in AND configured a pull-armed collector.
 * Bundles are shape-checked and returned; unrecognized entries are dropped. They are deliberately NOT
 * signature-verified or trust-gated — that is #6480's job, shipped in ./federated-import.ts (the peerKeys
 * allowlist). Returns [] rather than throwing on any failure, so an unreachable or hostile collector is
 * indistinguishable from "no peers yet" to every caller.
 */
export async function pullPeerBundles(manifest: ManifestSlice, opts: CollectorOpts = {}): Promise<FederatedSignalBundle[]> {
  const endpoint = resolveCollectorEndpoint(manifest, "pull");
  if (endpoint === null) return [];

  try {
    const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
    if (!rateLimitAllows(opts, now)) return [];

    const response = await fetchWithRetry(endpoint, { method: "GET", headers: { accept: "application/json" } }, opts);
    if (response === null) return [];

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return [];
    return payload.filter(isBundleShaped);
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", event: "federated_pull_failed", message: String(error).slice(0, 200) }),
    );
    return [];
  }
}
