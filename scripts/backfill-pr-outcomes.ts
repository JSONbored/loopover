#!/usr/bin/env node
// Backfill missing pr_outcome rows (#8823) — thin IO wrapper around backfill-pr-outcomes-core.ts.
//
// Runs INSIDE a self-hosted instance (it talks to the local ledger, not the cloud): reads completed terminal
// actions from audit_events, subtracts targets that already have a pr_outcome, and writes the missing rows.
// Idempotent — re-running writes nothing new.
//
//   node --experimental-strip-types scripts/backfill-pr-outcomes.ts --dry-run
//   node --experimental-strip-types scripts/backfill-pr-outcomes.ts --apply
//
// After applying, rewind orb_export_cursor so the corrected rows re-export to fleet calibration:
//   UPDATE orb_export_cursor SET last_exported_at = '<before the oldest backfilled action>';
import { planPrOutcomeBackfill, type TerminalActionRow } from "./backfill-pr-outcomes-core";

type Row = Record<string, unknown>;
type Db = {
  all: (sql: string, binds?: unknown[]) => Promise<Row[]>;
  run: (sql: string, binds?: unknown[]) => Promise<unknown>;
};

const TERMINAL_ACTIONS_SQL = `
  SELECT target_key AS "targetKey", event_type AS "eventType", created_at AS "createdAt"
    FROM audit_events
   WHERE event_type IN ('agent.action.merge', 'agent.action.close')
     AND outcome IN ('success', 'completed')
   ORDER BY created_at ASC`;

const RECORDED_SQL = `SELECT DISTINCT target_id AS "targetId" FROM review_audit WHERE event_type = 'pr_outcome'`;

export async function runBackfill(db: Db, apply: boolean, log: (line: string) => void = console.log): Promise<number> {
  const actionRows = (await db.all(TERMINAL_ACTIONS_SQL)) as unknown as TerminalActionRow[];
  const recordedRows = await db.all(RECORDED_SQL);
  const recorded = new Set(recordedRows.map((r) => String(r.targetId)));

  const plan = planPrOutcomeBackfill(actionRows, recorded);
  log(
    `backfill-pr-outcomes: ${actionRows.length} terminal action(s), ${recorded.size} already recorded -> ` +
      `${plan.entries.length} to write (skipped: ${plan.skipped.alreadyRecorded} recorded, ` +
      `${plan.skipped.unparseable} unparseable, ${plan.skipped.unknownAction} non-terminal)`,
  );
  if (!apply) {
    for (const entry of plan.entries.slice(0, 20)) log(`  would write ${entry.targetKey} -> ${entry.decision}`);
    if (plan.entries.length > 20) log(`  ... and ${plan.entries.length - 20} more`);
    log("backfill-pr-outcomes: DRY RUN — pass --apply to write");
    return plan.entries.length;
  }

  let written = 0;
  for (const entry of plan.entries) {
    // review_audit is the store the fleet export and computeGateEval read; the audit_events mirror carries the
    // same provenance the live writer stamps, tagged so a backfilled row is distinguishable from a live one.
    await db.run(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at)
       VALUES (?, ?, ?, 'pr_outcome', ?, 'gittensory-native', ?)`,
      [`backfill-${entry.targetKey}-${entry.createdAt}`.slice(0, 190), entry.project.slice(0, 200), entry.targetKey, entry.decision, entry.createdAt],
    );
    written += 1;
  }
  log(`backfill-pr-outcomes: wrote ${written} pr_outcome row(s)`);
  return written;
}
