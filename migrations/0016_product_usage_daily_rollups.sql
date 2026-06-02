CREATE TABLE IF NOT EXISTS product_usage_daily_rollups (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  total_events INTEGER NOT NULL DEFAULT 0,
  active_actors INTEGER NOT NULL DEFAULT 0,
  active_sessions INTEGER NOT NULL DEFAULT 0,
  active_repos INTEGER NOT NULL DEFAULT 0,
  source_event_count INTEGER NOT NULL DEFAULT 0,
  max_event_capacity INTEGER NOT NULL DEFAULT 0,
  first_event_at TEXT,
  last_event_at TEXT,
  surfaces_json TEXT NOT NULL DEFAULT '[]',
  outcomes_json TEXT NOT NULL DEFAULT '[]',
  events_json TEXT NOT NULL DEFAULT '[]',
  repos_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  route_classes_json TEXT NOT NULL DEFAULT '[]',
  activation_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_usage_daily_rollups_status_idx
  ON product_usage_daily_rollups(status, updated_at);
