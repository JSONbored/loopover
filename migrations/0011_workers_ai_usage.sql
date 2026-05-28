CREATE TABLE IF NOT EXISTS ai_usage_events (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  actor TEXT,
  route TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS ai_usage_events_feature_created_idx
  ON ai_usage_events(feature, created_at);

CREATE INDEX IF NOT EXISTS ai_usage_events_actor_created_idx
  ON ai_usage_events(actor, created_at);
