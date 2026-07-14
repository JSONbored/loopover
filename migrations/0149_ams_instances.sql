-- Gittensory AMS (#5681) — instance registration gate, mirroring orb_instances (see that table's own
-- migration for the full trust-model rationale). Every AMS instance that POSTs an anonymized batch to
-- /v1/ams/ingest is recorded here on first contact, but signals only count toward any future AMS-side
-- aggregate until an operator explicitly registers it (registered=1) — same das-github-mirror-modeled
-- trust anchor Orb already uses, so a stranger can't move an aggregate until a human opts them in.
CREATE TABLE IF NOT EXISTS ams_instances (
  instance_id    TEXT PRIMARY KEY NOT NULL,
  registered     INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  registered_at  TEXT
);

CREATE INDEX IF NOT EXISTS ams_instances_registered_idx ON ams_instances(registered);
