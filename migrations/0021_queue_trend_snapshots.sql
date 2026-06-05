CREATE TABLE IF NOT EXISTS repo_queue_trend_snapshots (
  repo_full_name TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
