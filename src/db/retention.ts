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

export const RETENTION_POLICY: readonly RetentionRule[] = [
  { table: "audit_events", column: "created_at", days: 90 },
  { table: "ai_usage_events", column: "created_at", days: 90 },
  { table: "product_usage_events", column: "occurred_at", days: 180 },
  { table: "github_rate_limit_observations", column: "observed_at", days: 30 },
  { table: "signal_snapshots", column: "generated_at", days: 90 },
  { table: "score_previews", column: "generated_at", days: 90 },
  { table: "repo_snapshots", column: "fetched_at", days: 90 },
];

export type PruneResult = { table: string; column: string; cutoff: string; deleted: number };

const SAFE_IDENTIFIER = /^[a-z_]+$/;
const BATCH_SIZE = 1000;
// Bound work per table per run so a first prune of a large backlog cannot blow the D1 statement budget;
// the daily cron drains any remainder over subsequent runs.
const MAX_DELETED_PER_TABLE = 50_000;
const MS_PER_DAY = 86_400_000;

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
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${rule.table} WHERE ${rule.column} < ?1`).bind(cutoff).first<{ n: number }>();
      results.push({ table: rule.table, column: rule.column, cutoff, deleted: Number(row?.n ?? 0) });
      continue;
    }

    let deleted = 0;
    // Batched delete by rowid so each statement is bounded; loop until a short batch or the per-run cap.
    for (;;) {
      const result = await env.DB.prepare(`DELETE FROM ${rule.table} WHERE rowid IN (SELECT rowid FROM ${rule.table} WHERE ${rule.column} < ?1 LIMIT ${batchSize})`)
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
