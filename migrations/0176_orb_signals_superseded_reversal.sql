-- #8820: admit the successor-merge reversal (#8166's reversal_superseded) into the fleet-calibration signal.
--
-- The exporter/ingest whitelist now carries reversal_flag='superseded', but orb_signals' CHECK constraint
-- (0060) still pins the column to ('none','reopened','reverted') — the ingest's INSERT OR REPLACE would hit
-- the constraint and its best-effort catch would SILENTLY skip the row, so the fleet's published
-- reversalRate stayed pinned at 0 no matter how many supersessions the instances detected. SQLite can't
-- alter a CHECK, so rebuild the table with the widened constraint, preserving existing rows (they are
-- continuously re-exported telemetry, but keeping them avoids a multi-day fleet-metrics blackout while
-- instances re-fill).

CREATE TABLE orb_signals_new (
  id                     INTEGER PRIMARY KEY,
  instance_id            TEXT    NOT NULL,                -- SHA256(ORB_APP_ID) prefix; one-way, no PII
  repo_hash              TEXT    NOT NULL,                -- HMAC(repo, instance secret); collector can't reverse
  pr_hash                TEXT    NOT NULL,                -- HMAC(repo#pr, instance secret)
  gate_verdict           TEXT,                            -- the prediction: 'merge' | 'close' | 'hold'
  outcome                TEXT    NOT NULL CHECK (outcome IN ('merged', 'closed')),  -- realized ground truth
  reversal_flag          TEXT    NOT NULL DEFAULT 'none' CHECK (reversal_flag IN ('none', 'reopened', 'reverted', 'superseded')),
  gate_reasoncode_bucket TEXT,                            -- low-cardinality category, bucketed at source
  time_to_close_ms       INTEGER,                         -- decision -> close cycle time (nullable)
  decision_timestamp     TEXT,                            -- when the gate decided
  outcome_timestamp      TEXT,                            -- when the PR resolved
  sent_at                TEXT,
  received_at            TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instance_id, repo_hash, pr_hash)                -- dedup unit: one row per PR per instance, upserted
);

INSERT INTO orb_signals_new (id, instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, time_to_close_ms, decision_timestamp, outcome_timestamp, sent_at, received_at)
  SELECT id, instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket, time_to_close_ms, decision_timestamp, outcome_timestamp, sent_at, received_at
  FROM orb_signals;

DROP TABLE orb_signals;
ALTER TABLE orb_signals_new RENAME TO orb_signals;

-- Recreate the indexes the rename does not carry over (same shapes as 0060).
CREATE INDEX IF NOT EXISTS orb_signals_calibration ON orb_signals (instance_id, gate_verdict, outcome, reversal_flag);
CREATE INDEX IF NOT EXISTS orb_signals_instance ON orb_signals (instance_id, received_at);
