CREATE TABLE IF NOT EXISTS upstream_source_snapshots (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  source_url TEXT NOT NULL,
  commit_sha TEXT,
  blob_sha TEXT,
  content_sha256 TEXT,
  etag TEXT,
  status TEXT NOT NULL DEFAULT 'fetched',
  parsed_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upstream_source_snapshots_key_fetched_idx
  ON upstream_source_snapshots (source_key, fetched_at);

CREATE INDEX IF NOT EXISTS upstream_source_snapshots_commit_idx
  ON upstream_source_snapshots (commit_sha);

CREATE TABLE IF NOT EXISTS upstream_ruleset_snapshots (
  id TEXT PRIMARY KEY,
  source_repo TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  commit_sha TEXT,
  source_snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
  active_model TEXT NOT NULL,
  registry_repo_count INTEGER NOT NULL DEFAULT 0,
  total_emission_share REAL NOT NULL DEFAULT 0,
  semantic_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upstream_ruleset_snapshots_generated_idx
  ON upstream_ruleset_snapshots (generated_at);

CREATE INDEX IF NOT EXISTS upstream_ruleset_snapshots_semantic_idx
  ON upstream_ruleset_snapshots (semantic_hash);

CREATE TABLE IF NOT EXISTS upstream_drift_reports (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT NOT NULL,
  affected_areas_json TEXT NOT NULL DEFAULT '[]',
  previous_ruleset_id TEXT,
  current_ruleset_id TEXT,
  issue_number INTEGER,
  issue_url TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS upstream_drift_reports_severity_status_idx
  ON upstream_drift_reports (severity, status);

CREATE INDEX IF NOT EXISTS upstream_drift_reports_updated_idx
  ON upstream_drift_reports (updated_at);
