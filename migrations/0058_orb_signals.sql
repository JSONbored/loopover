-- Gittensory Orb (#1219): central collector store. Receives anonymized outcome signal batches
-- from self-hosted instances running exportOrbBatch. repo_hash and pr_hash are HMAC-anonymized
-- by the sender — no repo names, owner identifiers, or PR content is stored here.
CREATE TABLE IF NOT EXISTS orb_signals (
  id              INTEGER PRIMARY KEY,
  instance_id     TEXT    NOT NULL,
  repo_hash       TEXT    NOT NULL,
  pr_hash         TEXT    NOT NULL,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('merged', 'closed')),
  gate_verdict    TEXT,
  time_to_close_ms INTEGER,
  sent_at         TEXT,
  received_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (instance_id, pr_hash)
);
CREATE INDEX IF NOT EXISTS orb_signals_instance ON orb_signals (instance_id, received_at);
