-- Gittensory Orb central GitHub App (#1255) — webhook delivery dedup + audit for POST /v1/orb/webhook.
-- The central Orb App is a SEPARATE GitHub App from the review app, with its OWN webhook secret and its OWN
-- delivery IDs, so it gets its OWN dedup table (not webhook_events) — a GitHub delivery_id is only unique per
-- App, so sharing one table across two Apps could collide. This receiver just verifies + records (PR1);
-- install-registry + PR-outcome processing land in later PRs.
CREATE TABLE IF NOT EXISTS orb_webhook_events (
  delivery_id TEXT PRIMARY KEY NOT NULL,
  event_name TEXT NOT NULL,
  action TEXT,
  installation_id INTEGER,
  repository_full_name TEXT,
  payload_hash TEXT NOT NULL,
  -- 'received' (recorded, not yet processed) | 'processed' | 'error'. Processing is added in a later PR.
  status TEXT NOT NULL DEFAULT 'received',
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS orb_webhook_events_status_idx ON orb_webhook_events(status);
CREATE INDEX IF NOT EXISTS orb_webhook_events_installation_idx ON orb_webhook_events(installation_id);
