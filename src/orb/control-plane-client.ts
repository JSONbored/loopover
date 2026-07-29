// The Worker's admin client for the hosted control plane's tenant API (#9522).
//
// packages/loopover-miner/lib/tenant-client.ts is the same client for the MINER, and this deliberately
// mirrors its posture rather than sharing code: that module reads `process.env` and is bundled into a Node
// CLI, while this one takes the Worker's `Env` binding, and the two products' env vars are separately
// namespaced on purpose (a self-hosted miner operator's control-plane credential is not this deployment's).
// What IS shared is the contract: control-plane/src/http-app.ts owns the wire shapes, and both clients speak
// exactly the routes it defines.
//
// Every call FAILS LOUD. Unlike an opportunistic read that can degrade, tenant create/destroy are deliberate
// admin actions: unconfigured, unreachable, non-2xx, or malformed all throw a clear Error rather than
// silently reporting success for something that did not happen. One bounded request per call and no retry --
// a create is not idempotent and must never be silently re-sent.
import { errorMessage } from "../utils/json";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type ControlPlaneFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ControlPlaneOptions = {
  fetchImpl?: ControlPlaneFetch;
  requestTimeoutMs?: number;
};

/** A tenant record as the control plane reports it. Lifecycle `state` vocabulary is the API's, passed through. */
export type TenantRecord = Record<string, unknown>;

export class ControlPlaneNotConfiguredError extends Error {
  constructor() {
    super("The hosted control plane is not configured on this deployment (LOOPOVER_CONTROL_PLANE_URL and LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN).");
    this.name = "ControlPlaneNotConfiguredError";
  }
}

/**
 * The configured control plane, or null when this deployment has none.
 *
 * Null rather than a throw so a CALLER can answer "not configured" as a structured result -- the tenant
 * tools report that shape instead of erroring, matching how every other unavailable capability answers.
 */
export function resolveControlPlane(env: Env): { baseUrl: string; token: string } | null {
  const rawUrl = env.LOOPOVER_CONTROL_PLANE_URL?.trim();
  const token = env.LOOPOVER_CONTROL_PLANE_ADMIN_TOKEN?.trim();
  if (!rawUrl || !token) return null;
  return { baseUrl: rawUrl.replace(/\/+$/, ""), token };
}

export function isControlPlaneConfigured(env: Env): boolean {
  return resolveControlPlane(env) !== null;
}

async function controlPlaneRequest(
  env: Env,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  options: ControlPlaneOptions,
): Promise<Record<string, unknown>> {
  const resolved = resolveControlPlane(env);
  if (!resolved) throw new ControlPlaneNotConfiguredError();
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as ControlPlaneFetch);
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) ? (options.requestTimeoutMs as number) : DEFAULT_REQUEST_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(`${resolved.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${resolved.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`control plane unreachable for ${method} ${path}: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    // The status is the whole diagnosis here and the body is operator-adjacent, so only the code travels.
    throw new Error(`control plane returned http_${response.status} for ${method} ${path}`);
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (payload === null || typeof payload !== "object") {
    throw new Error(`control plane returned a malformed response for ${method} ${path}`);
  }
  return payload;
}

/** `POST /v1/tenants`. `schedule` is valid only for product "ams", `orbInstallationId` only for "orb". */
export async function createTenant(
  env: Env,
  input: { name: string; product: string; schedule?: string | undefined; orbInstallationId?: number | undefined },
  options: ControlPlaneOptions = {},
): Promise<TenantRecord> {
  return controlPlaneRequest(env, "POST", "/v1/tenants", input, options);
}

/** `GET /v1/tenants`. */
export async function listTenants(env: Env, options: ControlPlaneOptions = {}): Promise<TenantRecord> {
  return controlPlaneRequest(env, "GET", "/v1/tenants", undefined, options);
}

/** `PATCH /v1/tenants/:name/orb-installation?product=orb`. */
export async function setTenantOrbInstallation(
  env: Env,
  input: { name: string; orbInstallationId: number },
  options: ControlPlaneOptions = {},
): Promise<TenantRecord> {
  const path = `/v1/tenants/${encodeURIComponent(input.name)}/orb-installation?product=orb`;
  return controlPlaneRequest(env, "PATCH", path, { orbInstallationId: input.orbInstallationId }, options);
}

/** `DELETE /v1/tenants/:name?product=<product>`. */
export async function destroyTenant(
  env: Env,
  input: { name: string; product: string },
  options: ControlPlaneOptions = {},
): Promise<TenantRecord> {
  const path = `/v1/tenants/${encodeURIComponent(input.name)}?product=${encodeURIComponent(input.product)}`;
  return controlPlaneRequest(env, "DELETE", path, undefined, options);
}

/** `GET /v1/tenants/:name/health?product=ams` -- the AMS tenant's wake schedule and last cycle outcome. */
export async function getAmsTenantHealth(env: Env, input: { name: string }, options: ControlPlaneOptions = {}): Promise<TenantRecord> {
  return controlPlaneRequest(env, "GET", `/v1/tenants/${encodeURIComponent(input.name)}/health?product=ams`, undefined, options);
}

/**
 * `POST /v1/tenants/:name/wake?product=ams` -- trigger a cycle now.
 *
 * The control plane applies the SAME per-tenant schedule guard the cron path obeys, so a wake too soon after
 * the last one comes back as a throttled answer rather than being forced through here.
 */
export async function wakeAmsTenant(env: Env, input: { name: string }, options: ControlPlaneOptions = {}): Promise<TenantRecord> {
  return controlPlaneRequest(env, "POST", `/v1/tenants/${encodeURIComponent(input.name)}/wake?product=ams`, {}, options);
}
