import { nowIso } from "../utils/json";

/**
 * Data-retention policy for the high-volume, append-only / log / superseded-snapshot tables. These hold
 * pure history (logs, usage metrics, ephemeral observations) or snapshots where only the latest matters,
 * so rows older than the window can be safely deleted. Current-state and reference tables (repositories,
 * repository_settings, pull_requests, issues, contributors, registry/scoring snapshots, repository_ai_keys,
 * focus manifests, webhook delivery idempotency records, etc.) are intentionally EXCLUDED — they are not append-only logs.
 *
 * `column` is the row's primary timestamp (ISO-8601). Windows are deliberately conservative.
 */
export type RetentionRule = { table: string; column: string; days: number };

const DURABLE_AUDIT_EVENT_TYPES = ["github_app.pr_public_surface_published"] as const;

export const RETENTION_POLICY: readonly RetentionRule[] = [
  { table: "audit_events", column: "created_at", days: 90 },
  { table: "ai_usage_events", column: "created_at", days: 90 },
  { table: "product_usage_events", column: "occurred_at", days: 180 },
  { table: "github_rate_limit_observations", column: "observed_at", days: 30 },
  { table: "signal_snapshots", column: "generated_at", days: 90 },
  { table: "score_previews", column: "generated_at", days: 90 },
  { table: "repo_snapshots", column: "fetched_at", days: 90 },
  // One payloadJson blob per agent run (#3896); a per-run diagnostic snapshot with no cross-run rollup
  // depending on it, so a shorter window than the audit/usage-log tables above is appropriate.
  { table: "agent_context_snapshots", column: "created_at", days: 30 },
];

export type PruneResult = { table: string; column: string; cutoff: string; deleted: number };

const SAFE_IDENTIFIER = /^[a-z_]+$/;
const BATCH_SIZE = 1000;
// Bound work per table per run so a first prune of a large backlog cannot blow the D1 statement budget;
// the daily cron drains any remainder over subsequent runs.
const MAX_DELETED_PER_TABLE = 50_000;
const MS_PER_DAY = 86_400_000;

function retentionWhere(rule: RetentionRule): string {
  const base = `${rule.column} < ?1`;
  if (rule.table === "audit_events") {
    const durableTypes = DURABLE_AUDIT_EVENT_TYPES.map((type) => `'${type}'`).join(", ");
    return `${base} AND event_type NOT IN (${durableTypes})`;
  }
  return base;
}

function cutoffIso(days: number, nowMs: number): string {
  return new Date(nowMs - days * MS_PER_DAY).toISOString();
}

/**
 * Delete (or, in dry-run, count) rows older than each table's retention window. Returns per-table results.
 * Table/column names come only from the hardcoded {@link RETENTION_POLICY} (never user input) and are
 * identifier-validated defensively; the cutoff is bound as a parameter. Deletes run in bounded batches.
 */
export async function pruneExpiredRecords(
  env: Env,
  options: { dryRun?: boolean; nowMs?: number; policy?: readonly RetentionRule[]; batchSize?: number; maxPerTable?: number } = {},
): Promise<PruneResult[]> {
  const dryRun = options.dryRun ?? false;
  const nowMs = options.nowMs ?? Date.parse(nowIso());
  const policy = options.policy ?? RETENTION_POLICY;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPerTable = options.maxPerTable ?? MAX_DELETED_PER_TABLE;
  const results: PruneResult[] = [];

  for (const rule of policy) {
    if (!SAFE_IDENTIFIER.test(rule.table) || !SAFE_IDENTIFIER.test(rule.column)) {
      throw new Error(`Unsafe retention identifier: ${rule.table}.${rule.column}`);
    }
    const cutoff = cutoffIso(rule.days, nowMs);

    if (dryRun) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${rule.table} WHERE ${retentionWhere(rule)}`).bind(cutoff).first<{ n: number }>();
      results.push({ table: rule.table, column: rule.column, cutoff, deleted: Number(row?.n ?? 0) });
      continue;
    }

    let deleted = 0;
    // Batched delete by rowid so each statement is bounded; loop until a short batch or the per-run cap.
    for (;;) {
      const result = await env.DB.prepare(`DELETE FROM ${rule.table} WHERE rowid IN (SELECT rowid FROM ${rule.table} WHERE ${retentionWhere(rule)} LIMIT ${batchSize})`)
        .bind(cutoff)
        .run();
      const changes = Number(result.meta?.changes ?? 0);
      deleted += changes;
      if (changes < batchSize || deleted >= maxPerTable) break;
    }
    results.push({ table: rule.table, column: rule.column, cutoff, deleted });
  }

  return results;
}

export type SignalSnapshotDedupeResult = { signalType: string; deleted: number };

/** Exported so the D1 size/row-count observability probe (#3810, src/selfhost/d1-size-probe.ts) can scope its
 *  signal_snapshots "rows per dedup key" ratio to exactly the population this dedup job converges to ~1 row
 *  per key -- NOT the whole table, which intentionally keeps bounded multi-row history for other signal
 *  types (queue-health, contributor-decision-pack, ...). Single source of truth: if this list changes, the
 *  probe's ratio scope changes with it automatically. */
export const LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES = [
  "repo-culture-profile",
  "repo-doc-refresh-attempt",
  "repo-focus-manifest",
  "repo-public-focus-manifest",
] as const;

/**
 * signal_snapshots has no dedup: `generate-signal-snapshots` inserts a NEW row per (signal_type,
 * target_key) on every run rather than replacing the prior one, so within RETENTION_POLICY's 90-day
 * age window a key can accumulate hundreds of superseded snapshots (#3810 -- 342,243 rows for 2,183
 * distinct keys contributed to hitting D1's size cap). Only latest-only cache signal types are
 * deduped; historical series such as queue-health and contributor-decision-pack keep their bounded
 * RETENTION_POLICY history for trend/change readers. This keeps only the latest row per
 * (signal_type, target_key), batched PER signal_type (not one table-wide window-function delete) so
 * each statement stays within D1's per-statement CPU budget -- the same batching split used during
 * the incident's manual remediation. "Latest" is the highest rowid per key: signal_snapshots is
 * populated by a single sequential batch job, so insertion order and generated_at agree, and rowid
 * (unlike generated_at) can never tie.
 */
export async function dedupeSignalSnapshots(
  env: Env,
  options: { dryRun?: boolean; batchSize?: number; maxPerType?: number } = {},
): Promise<SignalSnapshotDedupeResult[]> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxPerType = options.maxPerType ?? MAX_DELETED_PER_TABLE;
  const results: SignalSnapshotDedupeResult[] = [];

  const placeholders = LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES.map((_, index) => `?${index + 1}`).join(", ");
  const types = await env.DB.prepare(`SELECT DISTINCT signal_type FROM signal_snapshots WHERE signal_type IN (${placeholders})`)
    .bind(...LATEST_ONLY_SIGNAL_SNAPSHOT_TYPES)
    .all<{ signal_type: string }>();

  for (const { signal_type: signalType } of types.results) {
    const staleCondition = `signal_type = ?1 AND rowid NOT IN (SELECT MAX(rowid) FROM signal_snapshots WHERE signal_type = ?1 GROUP BY target_key)`;

    if (dryRun) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM signal_snapshots WHERE ${staleCondition}`).bind(signalType).first<{ n: number }>();
      results.push({ signalType, deleted: Number(row?.n ?? 0) });
      continue;
    }

    let deleted = 0;
    for (;;) {
      const result = await env.DB.prepare(`DELETE FROM signal_snapshots WHERE rowid IN (SELECT rowid FROM signal_snapshots WHERE ${staleCondition} LIMIT ${batchSize})`)
        .bind(signalType)
        .run();
      const changes = Number(result.meta?.changes ?? 0);
      deleted += changes;
      if (changes < batchSize || deleted >= maxPerType) break;
    }
    results.push({ signalType, deleted });
  }

  return results;
}
