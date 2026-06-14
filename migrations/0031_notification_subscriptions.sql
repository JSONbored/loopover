-- Event-to-subscription-to-delivery notifications (#535). The killer event is a changes_requested
-- review on a miner's PR (detected in src/notifications/events.ts). `notification_subscriptions` mirrors
-- `digest_subscriptions` and stores per-channel opt-out (badge is on by default unless paused).
-- `notification_deliveries` is the idempotent badge read-model: UNIQUE(dedup_key, channel) guarantees a
-- duplicate webhook / queue retry produces exactly one delivery.
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  destination TEXT,
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX notification_subscriptions_login_channel_unique
  ON notification_subscriptions(login, channel);
CREATE INDEX notification_subscriptions_login_idx ON notification_subscriptions(login);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_login TEXT NOT NULL,
  event_type TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  deeplink TEXT NOT NULL,
  actor_login TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  read_at TEXT
);

CREATE UNIQUE INDEX notification_deliveries_dedup_channel_unique
  ON notification_deliveries(dedup_key, channel);
CREATE INDEX notification_deliveries_recipient_status_idx
  ON notification_deliveries(recipient_login, status);
CREATE INDEX notification_deliveries_recipient_channel_created_idx
  ON notification_deliveries(recipient_login, channel, created_at);
