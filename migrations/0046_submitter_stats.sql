-- Convergence (#submitter-reputation): the INTERNAL-only per-(project, submitter) outcome-count table the
-- ported reputation module records into and reads. Tracks aggregate submission outcomes so the review path
-- can quietly factor a serial low-quality / abusive resubmitter into an anti-abuse signal (extends the
-- AI-spend gate — see src/review/submitter-reputation.ts + src/queue/processors.ts). STRICTLY INTERNAL:
-- NEVER surfaced publicly (no labels, comments, or check-runs) — it is an internal signal + a private /stats
-- input only. Aggregate counts ONLY; no PR content. Schema is byte-faithful to the reviewbot canonical table
-- (reviewbot migrations/0011_submitter_stats.sql) so the ported module's INSERT/SELECT bind exactly.
-- Additive + idempotent: the table is only ever read/written when the REVIEWBOT_REPUTATION flag is ON.
CREATE TABLE IF NOT EXISTS submitter_stats (
  project TEXT NOT NULL,
  submitter TEXT NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  manual INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  PRIMARY KEY (project, submitter)
);
