-- Gittensory AMS (#5681) — central telemetry collector store, mirroring orb_signals' pattern for the miner
-- product. Receives anonymized PR-outcome batches from opt-in AMS instances (orb-export.js). repo_hash and
-- pr_hash are HMAC-anonymized by the sender before this table ever sees them — no repo names, owner
-- identifiers, or PR content is stored here. A separate table from orb_signals rather than a shared
-- discriminator column: AMS has no gate_verdict/reversal_flag concept (a miner submission isn't gated the
-- way a reviewed PR is), so forcing both products into one row shape would mean a pile of always-null
-- Orb-only columns on every AMS row.
CREATE TABLE IF NOT EXISTS ams_signals (
  id            INTEGER PRIMARY KEY,
  instance_id   TEXT    NOT NULL,
  repo_hash     TEXT    NOT NULL,
  pr_hash       TEXT    NOT NULL,
  decision      TEXT    NOT NULL CHECK (decision IN ('merged', 'closed')),
  reason_bucket TEXT,
  closed_at     TEXT,
  received_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instance_id, pr_hash)
);
CREATE INDEX IF NOT EXISTS ams_signals_instance ON ams_signals (instance_id, received_at);
