ALTER TABLE ai_usage_events ADD COLUMN provider TEXT;
ALTER TABLE ai_usage_events ADD COLUMN effort TEXT;
ALTER TABLE ai_usage_events ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_events ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_events ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_events ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS ai_usage_events_provider_created_idx
  ON ai_usage_events(provider, created_at);
