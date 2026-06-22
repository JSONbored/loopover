// Metagraphed netuid verification (content-lane primitive).
//
// SELF-CONTAINED NATIVE PORT (reviewbot→gittensory convergence). Byte-faithful to the taostats /
// public-registry netuid-identity verification in reviewbot's src/agents/metagraphed/capabilities.ts
// (fetchSubnetRecord / checkNetuidExists / fetchTaostatsSubnetIdentity).
//
// TWO external integrations, BOTH fail-open:
//
//  1. PUBLIC REGISTRY (api.metagraph.sh) — NO API KEY. Base URL overridable via the env secret
//     METAGRAPHED_PUBLIC_API_BASE (else DEFAULT_PUBLIC_API_BASE). Confirms a subnet EXISTS + yields
//     its identity record. Ports cleanly; just needs network egress.
//
//  2. TAOSTATS on-chain identity (api.taostats.io) — REQUIRES the env secret TAOSTATS_API_KEY (sent
//     as a raw `Authorization` header, NOT `Bearer`). STRICTLY OPTIONAL + fail-open: returns null
//     when the key is unset or on any error, so the merge gate falls back to the page-mention +
//     registry-identity grounding signals. The key is NOT yet declared in gittensory's Env — see the
//     port report; wire it (a Worker secret) to enable signal #2, or leave it unset to disable it.
//
// I/O is the injected fetch (`fetchImpl`, default global fetch) + a `readSecret` over a plain env
// object — so this module is testable without the Cloudflare runtime. fetchWithRetry's retry/timeout
// behavior is inlined minimally (the reviewbot defaults: 2 retries, 250ms backoff, 10s timeout).
import { DEFAULT_PUBLIC_API_BASE } from "./registry-logic";

/** Env subset the netuid verification reads (secret/var names → string values). */
export type NetuidVerificationEnv = Record<string, unknown>;

/** Read a string secret/var off the env by name (reviewbot core/util.ts readSecret). */
function readSecret(env: NetuidVerificationEnv | undefined | null, name: string): string {
  const value = env?.[name];
  return typeof value === "string" ? value : "";
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal fetch-with-retry (inlined from reviewbot core/fetch-retry.ts defaults). Retries on a
 *  thrown error or a retryable status, with exponential backoff + a per-attempt timeout. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  opts: { retries?: number; baseDelayMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("fetch failed");
}

export interface SubnetRecord {
  status: "exists" | "missing" | "error";
  /** The identity-bearing subnet record (the `data.subnet` envelope), when the subnet exists. Used to
   *  derive the authoritative identity tokens a candidate's surface is corroborated against. */
  record: Record<string, unknown> | null;
}

/**
 * Fetch the declared netuid's PUBLIC-REGISTRY record. `{base}/subnets/{netuid}`: 200 with a real
 * record → exists (+ the identity record); 404 / empty envelope → missing; any other failure →
 * error (fail-safe to manual). NO API KEY. The base is `METAGRAPHED_PUBLIC_API_BASE` or the default.
 */
export async function fetchSubnetRecord(
  env: NetuidVerificationEnv,
  netuid: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SubnetRecord> {
  const base = (readSecret(env, "METAGRAPHED_PUBLIC_API_BASE") || DEFAULT_PUBLIC_API_BASE).replace(/\/+$/, "");
  try {
    const res = await fetchWithRetry(
      `${base}/subnets/${netuid}`,
      { headers: { accept: "application/json", "user-agent": "gittensory-content-lane" } },
      fetchImpl,
    );
    if (res.status === 404) return { status: "missing", record: null };
    if (!res.ok) throw new Error(`public registry returned ${res.status}`);
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    // Validate the SHAPE, not just non-emptiness: many APIs answer an unknown id with 200 + an
    // error/empty envelope. Require a real subnet record that echoes the netuid or carries known fields.
    if (!payload || typeof payload !== "object" || "error" in payload || (payload as { success?: unknown }).success === false) {
      return { status: "missing", record: null };
    }
    const data = ((payload as { data?: unknown }).data ?? payload) as Record<string, unknown> | unknown[] | null;
    if (!data || typeof data !== "object") return { status: "missing", record: null };
    if (Array.isArray(data)) {
      return data.length > 0
        ? { status: "exists", record: (data[0] ?? null) as Record<string, unknown> | null }
        : { status: "missing", record: null };
    }
    if ("error" in data) return { status: "missing", record: null };
    const subnetRaw = (data as { subnet?: unknown }).subnet;
    const subnet =
      subnetRaw && typeof subnetRaw === "object" && !Array.isArray(subnetRaw) ? (subnetRaw as Record<string, unknown>) : null;
    const recordFields = ["name", "owner", "surfaces", "candidates", "emission", "registered_at", "tempo"];
    const echoesNetuid =
      Number((data as { netuid?: unknown }).netuid) === netuid || (subnet != null && Number(subnet.netuid) === netuid);
    const hasRecordFields = recordFields.some((k) => k in data) || (subnet != null && recordFields.some((k) => k in subnet));
    if (!echoesNetuid && !hasRecordFields) return { status: "missing", record: null };
    return { status: "exists", record: subnet ?? (data as Record<string, unknown>) };
  } catch {
    return { status: "error", record: null };
  }
}

/** Back-compat existence-only wrapper (the duplicate/existence gate + tests). */
export async function checkNetuidExists(
  env: NetuidVerificationEnv,
  netuid: number,
  fetchImpl: typeof fetch = fetch,
): Promise<"exists" | "missing" | "error"> {
  return (await fetchSubnetRecord(env, netuid, fetchImpl)).status;
}

/**
 * Authoritative ON-CHAIN identity for a subnet via taostats — the netuid's registered name / github /
 * url / description from the Bittensor chain (SubnetIdentitiesV3). Lets a reviewer VERIFY a submitted
 * surface corroborates the subnet WITHOUT requiring the fetched page to literally print the netuid.
 *
 * Gated on TAOSTATS_API_KEY and FAIL-OPEN: returns null when the key is unset or on any error, so the
 * gate falls back to the page-mention + registry-identity checks. Endpoint shape (verified live):
 * GET …/subnet/identity/v1?netuid=N → { data: [{ netuid, subnet_name, github_repo, subnet_url,
 * description, summary, … }] }. The key is sent as a RAW `Authorization` header (not `Bearer`).
 */
export interface TaostatsIdentity {
  netuid: number;
  name: string | null;
  github: string | null;
  url: string | null;
  description: string | null;
}

export async function fetchTaostatsSubnetIdentity(
  env: NetuidVerificationEnv,
  netuid: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TaostatsIdentity | null> {
  const key = readSecret(env, "TAOSTATS_API_KEY");
  if (!key || !Number.isInteger(netuid)) return null;
  try {
    const res = await fetchWithRetry(
      `https://api.taostats.io/api/subnet/identity/v1?netuid=${netuid}`,
      { headers: { accept: "application/json", Authorization: key } },
      fetchImpl,
    );
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const rows = Array.isArray(payload?.data) ? (payload?.data as Array<Record<string, unknown>>) : [];
    const row = rows.find((r) => Number(r?.netuid) === netuid);
    if (!row) return null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      netuid,
      name: str(row.subnet_name),
      github: str(row.github_repo),
      url: str(row.subnet_url),
      description: str(row.description) ?? str(row.summary),
    };
  } catch {
    return null;
  }
}
