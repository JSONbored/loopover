-- Cache table for the federated queue pressure index.
-- TTL enforcement matches the burden forecast pattern (6-hour freshness threshold applied at read time).
CREATE TABLE IF NOT EXISTS queue_federation_snapshots (
  id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  repo_count INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS queue_federation_snapshots_generated_idx ON queue_federation_snapshots (generated_at);
