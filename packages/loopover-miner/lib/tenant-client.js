/** Admin client for the hosted control-plane's tenant-provisioning API (#7275, part of the #7173 ORB+AMS hosting
 * control-plane; talks to #7180's provisioning API). Opt-in and completely inert unless
 * LOOPOVER_MINER_CONTROL_PLANE is set AND a URL is configured -- mirroring discovery-index-client.js's env-gated,
 * never-auto-enabled posture. But UNLIKE that client's deliberately fail-OPEN opportunistic supplement, every
 * call here FAILS LOUD: create/list/destroy are deliberate admin actions, so a disabled/unconfigured/unreachable/
 * non-2xx/malformed-response condition throws a clear Error (surfaced by tenant-cli.js as a non-zero exit and
 * message) rather than silently degrading. Bearer-authed with an ADMIN credential, distinct from any tenant's own
 * per-instance secrets. Lifecycle states (`provisioning`/`active`/`suspended`/`torn down`) are passed through
 * exactly as the API reports them -- no AMS-specific state vocabulary is invented here. A single bounded request
 * per call (no retry): a create is not idempotent, so it must not be silently re-sent. */

export const CONTROL_PLANE_FLAG = "LOOPOVER_MINER_CONTROL_PLANE";
export const CONTROL_PLANE_URL_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_URL";
export const CONTROL_PLANE_ADMIN_TOKEN_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN";

const TRUTHY_ENV_VALUE = /^(1|true|yes|on)$/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isTruthyEnvValue(value) {
  return TRUTHY_ENV_VALUE.test(String(value).trim());
}

// Reads below use literal `env.LOOPOVER_MINER_*` property access (not the *_FLAG constants) because
// scripts/generate-env-reference.mjs statically greps for exactly this `env.NAME ?? "..."` shape to keep the
// generated env reference honest -- a dynamic `env[SOME_CONST]` lookup is invisible to it.

/** Master opt-in (default off): no control-plane traffic is possible until this is truthy. */
export function isControlPlaneEnabled(env = process.env) {
  return isTruthyEnvValue(env.LOOPOVER_MINER_CONTROL_PLANE ?? "");
}

function resolveControlPlaneUrl(env) {
  const raw = (env.LOOPOVER_MINER_CONTROL_PLANE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function resolveAdminToken(env) {
  const raw = typeof env.LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN === "string" ? env.LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN.trim() : "";
  return raw || null;
}

/** Resolve + validate the control-plane connection, or throw a clear admin-facing error (fail loud). */
function resolveControlPlane(env) {
  if (!isControlPlaneEnabled(env)) {
    throw new Error(`control plane disabled: set ${CONTROL_PLANE_FLAG}=1 to enable tenant admin commands`);
  }
  const baseUrl = resolveControlPlaneUrl(env);
  if (!baseUrl) throw new Error(`control plane URL unconfigured: set ${CONTROL_PLANE_URL_FLAG}`);
  const token = resolveAdminToken(env);
  if (!token) throw new Error(`control plane admin token unconfigured: set ${CONTROL_PLANE_ADMIN_TOKEN_FLAG}`);
  return { baseUrl, token };
}

/**
 * One bounded, Bearer-authed request against the control plane. Throws a clear Error on any failure: disabled/
 * unconfigured plane, unreachable host or timeout, non-2xx status, or a non-JSON/non-object body.
 *
 * @param {"GET"|"POST"|"DELETE"} method
 * @param {string} path
 * @param {unknown} body request body (JSON-encoded), or undefined for none
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} options
 * @returns {Promise<Record<string, unknown>>}
 */
async function controlPlaneRequest(method, path, body, options) {
  const env = options.env ?? process.env;
  const { baseUrl, token } = resolveControlPlane(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;

  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`control plane unreachable for ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`control plane returned http_${response.status} for ${method} ${path}`);
  }
  const payload = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    throw new Error(`control plane returned a malformed response for ${method} ${path}`);
  }
  return payload;
}

/**
 * Create a hosted tenant instance. Returns the created tenant record exactly as the control plane reports it
 * (including its lifecycle `state`). `options.product` defaults to `"ams"`.
 *
 * @param {string} name
 * @param {{ product?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export async function createTenant(name, options = {}) {
  const product = typeof options.product === "string" && options.product.trim() ? options.product.trim() : "ams";
  return controlPlaneRequest("POST", "/v1/tenants", { name, product }, options);
}

/**
 * List all hosted tenant instances the admin credential can see. Returns the `tenants` array as reported.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listTenants(options = {}) {
  const payload = await controlPlaneRequest("GET", "/v1/tenants", undefined, options);
  return Array.isArray(payload.tenants) ? payload.tenants : [];
}

/**
 * Tear down a hosted tenant instance by name. Returns the control plane's final record for it (typically the
 * transitional `torn down` lifecycle state).
 *
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export async function destroyTenant(name, options = {}) {
  return controlPlaneRequest("DELETE", `/v1/tenants/${encodeURIComponent(name)}`, undefined, options);
}
