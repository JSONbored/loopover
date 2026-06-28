-- Pull-mode relay (#16): a brokered self-host behind NAT/tailnet cannot receive PUSHED webhooks, so it PULLS
-- queued events from the Orb. Adds a per-enrollment delivery mode (default 'push' = unchanged) and a
-- per-installation pending-event queue the engine drains.
ALTER TABLE orb_enrollments ADD COLUMN relay_mode TEXT NOT NULL DEFAULT 'push';

CREATE TABLE IF NOT EXISTS orb_relay_pending (
  delivery_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orb_relay_pending_install ON orb_relay_pending (installation_id, created_at);
