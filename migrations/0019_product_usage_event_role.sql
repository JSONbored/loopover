ALTER TABLE product_usage_events ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS product_usage_events_role_occurred_idx
  ON product_usage_events(role, occurred_at);
