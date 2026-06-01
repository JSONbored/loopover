CREATE TABLE IF NOT EXISTS product_usage_events (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,
  event_name TEXT NOT NULL,
  route TEXT,
  actor_hash TEXT,
  session_hash TEXT,
  repo_full_name TEXT,
  target_key TEXT,
  outcome TEXT NOT NULL,
  latency_ms INTEGER,
  client_name TEXT,
  client_version TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_usage_events_surface_occurred_idx
  ON product_usage_events(surface, occurred_at);

CREATE INDEX IF NOT EXISTS product_usage_events_event_occurred_idx
  ON product_usage_events(event_name, occurred_at);

CREATE INDEX IF NOT EXISTS product_usage_events_actor_occurred_idx
  ON product_usage_events(actor_hash, occurred_at);

CREATE INDEX IF NOT EXISTS product_usage_events_repo_occurred_idx
  ON product_usage_events(repo_full_name, occurred_at);
