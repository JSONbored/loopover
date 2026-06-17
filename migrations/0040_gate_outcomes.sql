-- #554: gate false-positive telemetry. One row per (repo, PR) capturing the latest gate HARD-BLOCK, later
-- correlated with an eventual merge/override (resolution) to measure each gate type's false-positive rate.
-- No PII: only repo, PR number, gate pack, blocker codes, and timestamps.
CREATE TABLE gate_outcomes (
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  gate_pack TEXT NOT NULL DEFAULT 'gittensor',
  blocker_codes_json TEXT NOT NULL DEFAULT '[]',
  blocked_at TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, pr_number)
);
CREATE INDEX gate_outcomes_resolution_idx ON gate_outcomes (resolution);
