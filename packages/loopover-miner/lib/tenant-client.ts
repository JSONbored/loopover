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

import { TenantListResponseSchema, TenantRecordSchema, type TenantRecord } from "@loopover/contract/control-plane";

export type { TenantRecord };

export const CONTROL_PLANE_FLAG = "LOOPOVER_MINER_CONTROL_PLANE";
export const CONTROL_PLANE_URL_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_URL";
export const CONTROL_PLANE_ADMIN_TOKEN_FLAG = "LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN";

export type TenantClientOptions = {
  env?: Record<string, string | undefined>;
  /** Always called as `fetchImpl(url, init)` with a plain string URL -- narrower than `typeof fetch` on
   *  purpose, since that's the only shape this module ever actually calls it with. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
};

export type CreateTenantOptions = TenantClientOptions & {
  product?: string;
};

const TRUTHY_ENV_VALUE = /^(1|true|yes|on)$/i;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function isTruthyEnvValue(value: string): boolean {
  return TRUTHY_ENV_VALUE.test(String(value).trim());
}

// Reads below use literal `env.LOOPOVER_MINER_*` property access (not the *_FLAG constants) because
// scripts/generate-env-reference.ts statically greps for exactly this `env.NAME ?? "..."` shape to keep the
// generated env reference honest -- a dynamic `env[SOME_CONST]` lookup is invisible to it.

/** Master opt-in (default off): no control-plane traffic is possible until this is truthy. */
export function isControlPlaneEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isTruthyEnvValue(env.LOOPOVER_MINER_CONTROL_PLANE ?? "");
}

function resolveControlPlaneUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.LOOPOVER_MINER_CONTROL_PLANE_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function resolveAdminToken(env: Record<string, string | undefined>): string | null {
  const raw = typeof env.LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN === "string" ? env.LOOPOVER_MINER_CONTROL_PLANE_ADMIN_TOKEN.trim() : "";
  return raw || null;
}

/** Resolve + validate the control-plane connection, or throw a clear admin-facing error (fail loud). */
function resolveControlPlane(env: Record<string, string | undefined>): { baseUrl: string; token: string } {
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
async function controlPlaneRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: unknown,
  options: TenantClientOptions,
): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  const { baseUrl, token } = resolveControlPlane(env);
  const fetchImpl = options.fetchImpl ?? (fetch as (url: string, init: RequestInit) => Promise<Response>);
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) ? (options.requestTimeoutMs as number) : DEFAULT_REQUEST_TIMEOUT_MS;

  let response: Response;
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
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") {
    throw new Error(`control plane returned a malformed response for ${method} ${path}`);
  }
  return payload;
}

/**
 * Parse a control-plane response against the published schema (#9750).
 *
 * The client used to CAST every response to `Record<string, unknown>` and hand it straight to the CLI, so a
 * field the control plane renamed reached a printed table as `undefined` and nothing anywhere reported it.
 * Parsing is the fix, and it keeps this module's fail-loud posture: a create or destroy is a deliberate
 * admin action, so a response that does not match the contract is an error with a readable reason, not a
 * shrug. `TenantRecordSchema` is a loose object, so a control plane that starts returning an extra field
 * still parses -- only a MISSING or wrong-typed one fails.
 */
function parseResponse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: { message: string } } }, payload: unknown, method: string, path: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`control plane returned a response that does not match the published contract for ${method} ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Create a hosted tenant instance. Returns the created tenant record exactly as the control plane reports it
 * (including its lifecycle `state`). `options.product` defaults to `"ams"`.
 *
 * @param {string} name
 * @param {{ product?: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export async function createTenant(name: string, options: CreateTenantOptions = {}): Promise<TenantRecord> {
  const product = typeof options.product === "string" && options.product.trim() ? options.product.trim() : "ams";
  return parseResponse(TenantRecordSchema, await controlPlaneRequest("POST", "/v1/tenants", { name, product }, options), "POST", "/v1/tenants");
}

/**
 * List all hosted tenant instances the admin credential can see. Returns the `tenants` array as reported.
 *
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listTenants(options: TenantClientOptions = {}): Promise<TenantRecord[]> {
  const payload = await controlPlaneRequest("GET", "/v1/tenants", undefined, options);
  // Was `Array.isArray(payload.tenants) ? payload.tenants : []` -- a missing or malformed `tenants` silently
  // became "you have no tenants", which is the most misleading possible answer for an admin listing.
  return parseResponse(TenantListResponseSchema, payload, "GET", "/v1/tenants").tenants;
}

/**
 * Tear down a hosted tenant instance by name. Returns the control plane's final record for it (typically the
 * transitional `torn down` lifecycle state).
 *
 * @param {string} name
 * @param {{ env?: Record<string, string | undefined>, fetchImpl?: typeof fetch, requestTimeoutMs?: number }} [options]
 */
export async function destroyTenant(name: string, options: TenantClientOptions = {}): Promise<TenantRecord> {
  const path = `/v1/tenants/${encodeURIComponent(name)}`;
  return parseResponse(TenantRecordSchema, await controlPlaneRequest("DELETE", path, undefined, options), "DELETE", path);
}
