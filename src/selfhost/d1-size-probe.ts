// Cloudflare D1 size + row-count observability probe (central-cloud storage, #3810). The Cloudflare D1
// database backing gittensory's shared cloud gittensory-api/Orb deployment hit its ~10GB account storage
// cap on 2026-07-06 -- see src/db/retention.ts's dedupeSignalSnapshots for the write-side root-cause fix
// (signal_snapshots was accumulating hundreds of superseded rows per key). D1's own query surface has no way
// to report the database's FILE size as a metric from inside a query -- that figure only exists via the
// Cloudflare Management API (`GET .../d1/database/{id}` -> `file_size`), and per-table row counts need an
// actual `COUNT(*)` run through that same account-scoped HTTP API rather than a local binding: self-host
// runs its own SQLite/Postgres backend (see d1-adapter.ts / pg-adapter.ts), so there is no `env.DB` binding
// anywhere that actually points at the central cloud database this module is built to watch.
//
// OPT-IN, CREDENTIAL-GATED, NEW INTEGRATION: grepping this repo before writing this file found ZERO existing
// Cloudflare Management API usage anywhere (no wrangler binding covers it), so every call here is a plain
// authenticated HTTPS request -- the same shape as this repo's existing external JSON-API clients (see
// src/gittensor/api.ts's fetchJson: hard fetch timeout, throw on non-OK). Presence of all three
// CLOUDFLARE_D1_MONITOR_* env vars IS the enablement switch, the same convention as isOrbBrokerMode's
// ORB_ENROLLMENT_SECRET-presence check (src/orb/broker-client.ts) -- most self-host operators run their own
// SQLite/Postgres backend and have nothing to monitor here; this exists for whichever deployment owns a real
// Cloudflare D1 worth watching (including gittensory's own central cloud database). Wired into the self-host
// process's OWN boot-time interval registrations in server.ts (mirroring the Orb relay registration retry
// timer), NOT the Cloudflare Worker `scheduled()` cron: that cron's job registry is shared with the hosted
// cloud Worker's ephemeral, multi-isolate request lifecycle, which cannot reliably carry an in-memory sample
// from a scheduled tick through to a later /metrics scrape the way one long-running self-host process can
// (self-host's /metrics is served from the SAME process that runs this timer -- see GET /metrics in
// server.ts).

import { LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES, RETENTION_POLICY } from "../db/retention";
import { errorMessage } from "../utils/json";
import { incr } from "./metrics";
import type { VectorSample } from "./metrics";

export interface D1SizeProbeEnv {
  CLOUDFLARE_D1_MONITOR_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_D1_MONITOR_DATABASE_ID?: string | undefined;
  CLOUDFLARE_D1_MONITOR_API_TOKEN?: string | undefined;
}

// The same high-volume, unbounded-growth-risk tables RETENTION_POLICY already age-prunes (src/db/
// retention.ts) -- reused directly rather than re-listed so the two never drift apart.
const DEFAULT_MONITORED_TABLES: readonly string[] = RETENTION_POLICY.map((rule) => rule.table);

export interface D1SizeProbeConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  /** Tables to report a row count for. Always {@link DEFAULT_MONITORED_TABLES} in production; overridable
   *  only so tests can exercise the fan-out without mocking a fetch per real monitored table. */
  tables: readonly string[];
}

/** Every identifier passed here comes only from the hardcoded {@link DEFAULT_MONITORED_TABLES} (never user
 *  input); validated defensively anyway, mirroring retention.ts's own SAFE_IDENTIFIER check. */
const SAFE_TABLE_NAME = /^[a-z_]+$/;

/** signal_snapshots' own dedup key, mirroring dedupeSignalSnapshots' partition (src/db/retention.ts). */
const SIGNAL_SNAPSHOTS_DEDUP_KEY_SQL = "signal_type || ':' || target_key";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
/** Hard cap on a single Cloudflare Management API request, mirroring src/gittensor/api.ts's
 *  GITTENSOR_FETCH_TIMEOUT_MS -- a slow/half-open Cloudflare API call must never hang the self-host
 *  process's probe timer indefinitely. */
const D1_PROBE_FETCH_TIMEOUT_MS = 10_000;

/** Reads all three CLOUDFLARE_D1_MONITOR_* vars; returns null (probe disabled) unless every one is a
 *  non-empty string. Config presence IS the enablement switch -- there is no separate boolean flag. */
export function resolveD1SizeProbeConfig(env: D1SizeProbeEnv): D1SizeProbeConfig | null {
  const accountId = env.CLOUDFLARE_D1_MONITOR_ACCOUNT_ID;
  const databaseId = env.CLOUDFLARE_D1_MONITOR_DATABASE_ID;
  const apiToken = env.CLOUDFLARE_D1_MONITOR_API_TOKEN;
  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken, tables: DEFAULT_MONITORED_TABLES };
}

export function isD1SizeProbeEnabled(env: D1SizeProbeEnv): boolean {
  return resolveD1SizeProbeConfig(env) !== null;
}

interface CloudflareApiError {
  code: number;
  message: string;
}
interface CloudflareApiEnvelope<T> {
  success: boolean;
  errors?: CloudflareApiError[];
  result: T;
}

async function cloudflareApiRequest<T>(config: D1SizeProbeConfig, path: string, init: RequestInit | undefined, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}/accounts/${config.accountId}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(D1_PROBE_FETCH_TIMEOUT_MS),
  });
  let body: CloudflareApiEnvelope<T> | null = null;
  try {
    body = (await response.json()) as CloudflareApiEnvelope<T>;
  } catch {
    body = null;
  }
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare D1 API request failed (${path}): ${message}`);
  }
  return body.result;
}

export interface D1DatabaseInfo {
  fileSizeBytes: number;
  numTables: number;
}

/** `GET /accounts/{account}/d1/database/{database}` -- the only place D1's own file size is exposed. */
export async function fetchD1DatabaseInfo(config: D1SizeProbeConfig, fetchImpl: typeof fetch = fetch): Promise<D1DatabaseInfo> {
  const result = await cloudflareApiRequest<{ file_size?: number; num_tables?: number }>(config, `/d1/database/${config.databaseId}`, { method: "GET" }, fetchImpl);
  return { fileSizeBytes: Number(result.file_size ?? 0), numTables: Number(result.num_tables ?? 0) };
}

export interface D1TableRowCount {
  table: string;
  rowCount: number;
  /** Present ONLY for "signal_snapshots" -- the row count and distinct (signal_type, target_key) count
   *  scoped to JUST {@link LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES} (dedupeSignalSnapshots' own partition).
   *  Absent for every other monitored table, which has no per-key dedup invariant to measure. Modeled as one
   *  optional nested object (not two independently-nullable fields) because the two numbers are only ever
   *  meaningful, or only ever absent, TOGETHER -- there is no state where one exists without the other. */
  dedup?: { rowCount: number; distinctKeyCount: number };
}

function rowCountQuery(table: string): { sql: string; params: string[] } {
  if (table === "signal_snapshots") {
    // Numbered placeholders reused across both IN(...) clauses need only ONE bound value per index --
    // mirrors dedupeSignalSnapshots' own `?1` reuse in src/db/retention.ts.
    const placeholders = LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES.map((_, index) => `?${index + 1}`).join(", ");
    return {
      sql:
        `SELECT COUNT(*) AS total, ` +
        `(SELECT COUNT(*) FROM signal_snapshots WHERE signal_type IN (${placeholders})) AS dedup_total, ` +
        `(SELECT COUNT(DISTINCT ${SIGNAL_SNAPSHOTS_DEDUP_KEY_SQL}) FROM signal_snapshots WHERE signal_type IN (${placeholders})) AS dedup_distinct_keys ` +
        `FROM signal_snapshots`,
      params: [...LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES],
    };
  }
  return { sql: `SELECT COUNT(*) AS total FROM ${table}`, params: [] };
}

/** `POST /accounts/{account}/d1/database/{database}/query` for one monitored table's row count (plus,
 *  for "signal_snapshots" only, the dedup-scoped row/distinct-key counts). Throws on an unsafe table name
 *  (defense in depth -- see {@link SAFE_TABLE_NAME}) or a failed/malformed API response. */
export async function fetchD1TableRowCount(config: D1SizeProbeConfig, table: string, fetchImpl: typeof fetch = fetch): Promise<D1TableRowCount> {
  if (!SAFE_TABLE_NAME.test(table)) throw new Error(`Unsafe D1 monitored table identifier: ${table}`);
  const { sql, params } = rowCountQuery(table);
  const [queryResult] = await cloudflareApiRequest<{ results?: Record<string, number>[] }[]>(
    config,
    `/d1/database/${config.databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
    fetchImpl,
  );
  const row = queryResult?.results?.[0] ?? {};
  return {
    table,
    rowCount: Number(row.total ?? 0),
    ...(table === "signal_snapshots"
      ? { dedup: { rowCount: Number(row.dedup_total ?? 0), distinctKeyCount: Number(row.dedup_distinct_keys ?? 0) } }
      : {}),
  };
}

interface D1ProbeSample {
  fileSizeBytes: number;
  tableRowCounts: D1TableRowCount[];
}

let lastSample: D1ProbeSample | null = null;

function logD1ProbeError(part: "database_info" | "table_row_count", error: unknown, table?: string): void {
  incr("gittensory_d1_probe_errors_total", { part });
  console.error(JSON.stringify({ level: "error", event: "d1_size_probe_error", part, ...(table ? { table } : {}), message: errorMessage(error).slice(0, 200) }));
}

/**
 * Refresh the D1 size/row-count sample (called on a slow self-host timer, see server.ts). No-op when
 * {@link resolveD1SizeProbeConfig} returns null (probe disabled/unconfigured).
 *
 * Size and each monitored table's row count are fetched independently and a failure in one never blanks the
 * other: a failed fetch keeps its PREVIOUS reading (recorded via `gittensory_d1_probe_errors_total`) instead
 * of resetting to -1 or dropping out of the row-count vector, so a transient Cloudflare API hiccup reads on
 * the dashboard as "stale" rather than a false "suddenly zero" or a gap.
 */
export async function runD1SizeProbe(env: D1SizeProbeEnv, fetchImpl: typeof fetch = fetch): Promise<void> {
  const config = resolveD1SizeProbeConfig(env);
  if (!config) return;

  const [freshInfo, freshRowCounts] = await Promise.all([
    fetchD1DatabaseInfo(config, fetchImpl).catch((error: unknown) => {
      logD1ProbeError("database_info", error);
      return null;
    }),
    Promise.all(
      config.tables.map((table) =>
        fetchD1TableRowCount(config, table, fetchImpl).catch((error: unknown) => {
          logD1ProbeError("table_row_count", error, table);
          return null;
        }),
      ),
    ).then((rows) => rows.filter((row): row is D1TableRowCount => row !== null)),
  ]);

  const tableRowCountsByTable = new Map((lastSample?.tableRowCounts ?? []).map((row) => [row.table, row]));
  for (const row of freshRowCounts) tableRowCountsByTable.set(row.table, row);

  lastSample = {
    fileSizeBytes: freshInfo?.fileSizeBytes ?? lastSample?.fileSizeBytes ?? -1,
    tableRowCounts: [...tableRowCountsByTable.values()],
  };
}

/** -1 sentinel (matching gittensory_host_load_avg1_per_core's convention): distinguishes "probe disabled or
 *  has never completed a successful sample" from a genuine 0-byte reading. */
export function d1DatabaseSizeBytesSample(): number {
  return lastSample?.fileSizeBytes ?? -1;
}

/** One series per monitored table with a successful sample so far. Empty (not absent) when the probe is
 *  disabled or has never completed -- see metrics.ts's gaugeVector: "no data" on the dashboard, not a
 *  missing metric name. */
export function d1TableRowCountSamples(): VectorSample[] {
  return (lastSample?.tableRowCounts ?? []).map((row) => ({ labels: { table: row.table }, value: row.rowCount }));
}

/**
 * signal_snapshots rows per distinct dedup key, scoped to {@link LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES} only
 * (see rowCountQuery) -- should stay a small multiple of 1 once dedupeSignalSnapshots (src/db/retention.ts)
 * runs on its daily cadence; a climbing value means the dedup job has stopped running or its allowlist
 * regressed. -1 when unavailable (probe disabled, never sampled yet, or no dedup-scoped rows exist).
 */
export function d1SignalSnapshotsRowsPerKeySample(): number {
  const dedup = lastSample?.tableRowCounts.find((r) => r.table === "signal_snapshots")?.dedup;
  if (!dedup || dedup.distinctKeyCount === 0) return -1;
  return dedup.rowCount / dedup.distinctKeyCount;
}

/** Test-only: reset the module-level sample between tests. */
export function resetD1SizeProbeForTest(): void {
  lastSample = null;
}
