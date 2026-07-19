/** Opt-in client for the hosted discovery-index service (#4250, #7164/#7166/#7168). Complete no-op unless
 * LOOPOVER_MINER_DISCOVERY_PLANE is set -- mirrors sentry.js's own-project opt-in posture: nothing here is ever
 * auto-enabled or phones home by default. Supplements (never replaces) opportunity-fanout.js's per-instance
 * GitHub fan-out with results from the shared, centrally-cached index, and submits soft-claim coordination at
 * work-start/work-end -- the fleet-wide rate-limit mitigation packages/loopover-miner/docs/discovery-plane-
 * operator-guide.md documents. Every call here is fail-open (never throws, degrades to "no supplement"/"no
 * telemetry sent" on any error), matching orb-export.js's sendAmsExportBatch: an optional-plane hiccup must
 * never break the miner's real discover/attempt work. Uses @loopover/engine's discovery-index-contract.ts and
 * discovery-soft-claim.ts exports directly rather than re-implementing the shapes. */
import { normalizeDiscoveryIndexRequest, normalizeDiscoveryIndexResponse, buildSoftClaimRequest } from "@loopover/engine";
import { fetchWithRetry } from "./http-retry.js";
import { describeCliError } from "./cli-error.js";
import { getLogger } from "./logger.js";

export const DISCOVERY_PLANE_FLAG = "LOOPOVER_MINER_DISCOVERY_PLANE";
export const DISCOVERY_INDEX_URL_FLAG = "LOOPOVER_MINER_DISCOVERY_INDEX_URL";
export const DISCOVERY_TELEMETRY_FLAG = "LOOPOVER_MINER_DISCOVERY_TELEMETRY";

const TRUTHY_ENV_VALUE = /^(1|true|yes|on)$/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUE.test(value.trim());
}

// Reads below use literal `env.LOOPOVER_MINER_*` property access (not the exported *_FLAG constants above,
// which exist for callers/tests to reference the exact name without a typo) because
// scripts/generate-env-reference.mjs statically greps for exactly this `env.NAME ?? "default"` shape to keep
// packages/loopover-miner/docs/env-reference.md honest -- a dynamic `env[SOME_CONST]` lookup is invisible to it.

/** Master opt-in (default off). When false, no discovery-index traffic and no telemetry may be emitted. */
export function isDiscoveryPlaneEnabled(env = process.env) {
  return isTruthyEnvValue(env.LOOPOVER_MINER_DISCOVERY_PLANE ?? "");
}

/** Second, independent opt-in (default off) for anonymized operational telemetry -- can stay off while the
 *  plane itself is queried/claimed against. */
export function isDiscoveryTelemetryEnabled(env = process.env) {
  return isTruthyEnvValue(env.LOOPOVER_MINER_DISCOVERY_TELEMETRY ?? "");
}

function resolveDiscoveryIndexUrl(env) {
  const raw = (env.LOOPOVER_MINER_DISCOVERY_INDEX_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function authHeaders(env) {
  const secret = typeof env.LOOPOVER_MINER_DISCOVERY_SHARED_SECRET === "string" ? env.LOOPOVER_MINER_DISCOVERY_SHARED_SECRET.trim() : "";
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

const EMPTY_QUERY_RESPONSE = Object.freeze({ contractVersion: 1, candidates: [], nextCursor: null });

/**
 * Query the hosted discovery-index for supplementary candidates. Returns `EMPTY_QUERY_RESPONSE` (never throws)
 * when the plane is disabled, the URL is unconfigured, or the request fails for any reason -- callers can
 * always safely concatenate `.candidates` onto their own locally-discovered set with zero special-casing.
 */
export async function queryDiscoveryIndex(query, options = {}) {
  const env = options.env ?? process.env;
  if (!isDiscoveryPlaneEnabled(env)) return EMPTY_QUERY_RESPONSE;
  const baseUrl = resolveDiscoveryIndexUrl(env);
  if (!baseUrl) return EMPTY_QUERY_RESPONSE;

  const fetchImpl = options.fetchImpl ?? fetch;
  const { request } = normalizeDiscoveryIndexRequest(query);
  try {
    const response = await fetchWithRetry(
      fetchImpl,
      `${baseUrl}/v1/discovery-index/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(env) },
        body: JSON.stringify(request.query),
      },
      { timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    );
    if (!response.ok) return EMPTY_QUERY_RESPONSE;
    const payload = await response.json().catch(() => null);
    return normalizeDiscoveryIndexResponse(payload).response;
  } catch {
    return EMPTY_QUERY_RESPONSE;
  }
}

/**
 * Best-effort soft-claim submission at work-start/work-end. `claim` is the object returned by claim-ledger.js's
 * claimIssueWithinCap(...).claim (or its rowToClaim shape generally) -- passed straight into buildSoftClaimRequest
 * with no translation, per that builder's own contract. Fire-and-forget: never throws, and the caller's real
 * work (already underway once this is called) is never blocked or aborted by a plane hiccup. Returns
 * `{sent: boolean}` for callers that want to log/test the outcome without depending on it for control flow.
 */
export async function submitSoftClaim(claim, options = {}) {
  const env = options.env ?? process.env;
  if (!isDiscoveryPlaneEnabled(env)) return { sent: false };
  const baseUrl = resolveDiscoveryIndexUrl(env);
  if (!baseUrl) return { sent: false };

  const request = buildSoftClaimRequest(claim);
  if (request === null) return { sent: false };

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchWithRetry(
      fetchImpl,
      `${baseUrl}/v1/discovery-index/soft-claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders(env) },
        body: JSON.stringify(request),
      },
      { timeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    );
    return { sent: response.ok };
  } catch (error) {
    getLogger().debug("discovery_plane_soft_claim_failed", { error: describeCliError(error) });
    return { sent: false };
  }
}

/**
 * Emit anonymized, low-cardinality operational telemetry about the plane itself (never per-issue business
 * data) -- gated separately behind LOOPOVER_MINER_DISCOVERY_TELEMETRY, per the operator guide's invariant list
 * ("low-cardinality reason buckets", mirroring orb-export.js's `reasonBucket` convention). No hosted telemetry
 * collector endpoint exists for the discovery plane yet (out of scope for #7164/#7166), so this emits a
 * structured local log line via this package's own logger -- the gate, shape, and off-by-default behavior are
 * real and tested; swapping in a real remote sink later is a logger-call change, not a design change.
 */
export function recordDiscoveryTelemetry(event, outcome, options = {}) {
  const env = options.env ?? process.env;
  if (!isDiscoveryPlaneEnabled(env) || !isDiscoveryTelemetryEnabled(env)) return;
  getLogger().info("discovery_plane_telemetry", { event, outcome });
}
