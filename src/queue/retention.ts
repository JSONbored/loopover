// Data-retention pruning (#4013 step 7 -- extracted from processors.ts, seventh step of the file's own
// module-split sequence, after transient-locks.ts, signal-snapshot.ts, duplicate-detection.ts,
// slop-detection.ts, review-evasion.ts, and ci-resolution.ts). Pure move.

import { recordAuditEvent } from "../db/repositories";
import { dedupeSignalSnapshots, pruneExpiredRecords } from "../db/retention";

/**
 * Run (or dry-run) the data-retention prune across the configured log/snapshot tables, plus the
 * signal_snapshots dedup pass (#3810 -- signal_snapshots has no natural dedup, so within its own
 * retention window a key can still accumulate many superseded rows), and audit the combined outcome.
 * The per-table windows live in RETENTION_POLICY; only append-only/superseded tables are pruned.
 */
export async function runRetentionPrune(
  env: Env,
  requestedBy: string,
  dryRun: boolean,
): Promise<void> {
  const results = await pruneExpiredRecords(env, { dryRun });
  const dedupeResults = await dedupeSignalSnapshots(env, { dryRun });
  const totalDeleted = results.reduce((sum, result) => sum + result.deleted, 0);
  const totalDeduped = dedupeResults.reduce((sum, result) => sum + result.deleted, 0);
  await recordAuditEvent(env, {
    eventType: "retention.prune",
    actor: requestedBy,
    outcome: dryRun ? "completed" : "success",
    detail: dryRun
      ? `dry-run: ${totalDeleted} row(s) eligible, ${totalDeduped} duplicate signal_snapshots row(s) eligible`
      : `pruned ${totalDeleted} row(s), deduped ${totalDeduped} signal_snapshots row(s)`,
    metadata: {
      dryRun,
      totalDeleted,
      perTable: Object.fromEntries(results.map((r) => [r.table, r.deleted])),
      totalDeduped,
      perSignalType: Object.fromEntries(dedupeResults.map((r) => [r.signalType, r.deleted])),
    },
  });
}
