-- Gittensory Orb (#1255): turn Orb into the central fleet-calibration collector.
--
-- Retire the per-instance Orb GitHub App pipeline (orb_events / orb_installations were written by the
-- now-removed /orb/webhook handler). Each self-hosted instance already records de-noised ground truth in
-- review_audit (gate_decision + pr_outcome + reversal_*), so the exporter now reads THAT and ships an
-- anonymized, reversal-aware signal up to the central orb_signals store.

DROP TABLE IF EXISTS orb_events;
DROP TABLE IF EXISTS orb_installations;

-- orb_signals is young, continuously-regenerated telemetry (instances re-export). SQLite can't ALTER away the
-- old table-level UNIQUE(instance_id, pr_hash) — which is wrong (two instances reviewing owner/repo#123
-- collide) — so recreate with the correct key + the new reversal/timestamp/reason columns.
DROP TABLE IF EXISTS orb_signals;
CREATE TABLE IF NOT EXISTS orb_signals (
  id                     INTEGER PRIMARY KEY,
  instance_id            TEXT    NOT NULL,                -- SHA256(ORB_APP_ID) prefix; one-way, no PII
  repo_hash              TEXT    NOT NULL,                -- HMAC(repo, instance secret); collector can't reverse
  pr_hash                TEXT    NOT NULL,                -- HMAC(repo#pr, instance secret)
  gate_verdict           TEXT,                            -- the prediction: 'merge' | 'close' | 'hold'
  outcome                TEXT    NOT NULL CHECK (outcome IN ('merged', 'closed')),  -- realized ground truth
  reversal_flag          TEXT    NOT NULL DEFAULT 'none' CHECK (reversal_flag IN ('none', 'reopened', 'reverted')),
  gate_reasoncode_bucket TEXT,                            -- low-cardinality category, bucketed at source
  time_to_close_ms       INTEGER,                         -- decision -> close cycle time (nullable)
  decision_timestamp     TEXT,                            -- when the gate decided
  outcome_timestamp      TEXT,                            -- when the PR resolved
  sent_at                TEXT,
  received_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instance_id, repo_hash, pr_hash)                -- dedup unit: one row per PR per instance, upserted
);
-- Supports the (verdict, outcome, reversal) confusion-matrix rollups that are the whole point of the table.
CREATE INDEX IF NOT EXISTS orb_signals_calibration ON orb_signals (instance_id, gate_verdict, outcome, reversal_flag);
CREATE INDEX IF NOT EXISTS orb_signals_instance ON orb_signals (instance_id, received_at);

-- Export watermark per self-host instance — replaces orb_events.exported_at (review_audit is append-only, so
-- the exporter tracks the latest exported event time and ships only newer resolved PRs / reversals).
CREATE TABLE IF NOT EXISTS orb_export_cursor (
  instance_hash    TEXT PRIMARY KEY,
  last_exported_at TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z',
  updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
