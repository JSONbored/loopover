-- #9474: durable running totals for orb_pr_outcomes' CUMULATIVE public consumer.
--
-- #9415 gave orb_pr_outcomes a 90-day retention window, but getOrbGlobalStats SUMs the ENTIRE table and
-- public-stats folds that into the homepage's all-time merged/closed/handled counters. Once rows began aging
-- past 90 days (~2026-10-25 given #9415's merge date) the "all-time" numbers would have plateaued and then
-- visibly DECREASED -- a published cumulative counter going backwards.
--
-- The retention prune now folds each about-to-be-deleted row into this table first, atomically (same batch
-- transaction as the delete -- see pruneExpiredRecords' orb_pr_outcomes special case), and getOrbGlobalStats
-- adds these totals to its live scan. Keyed per LOWERCASED account_login (matching the stats query's own
-- LOWER() comparison; '' for a NULL login) so its excludeAccount de-dup keeps working after the raw rows are
-- gone. Only rows the live query would have counted are folded: registered installations, no published
-- review surface.
CREATE TABLE IF NOT EXISTS orb_outcome_rollups (
  account_login TEXT PRIMARY KEY,
  merged INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- #9489/#9474: verifyDecisionLedger's completeness reconciliation now asks "does ANY ledger row vouch for
-- this record" (a NOT EXISTS anti-join finding interior orphans, not just tail ones); without this index
-- that is a full ledger scan per candidate record.
CREATE INDEX IF NOT EXISTS decision_ledger_record_id ON decision_ledger (record_id);
