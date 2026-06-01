CREATE TABLE IF NOT EXISTS digest_subscriptions (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'app',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS digest_subscriptions_login_email_unique
  ON digest_subscriptions(login, email);

CREATE INDEX IF NOT EXISTS digest_subscriptions_login_idx
  ON digest_subscriptions(login);

CREATE INDEX IF NOT EXISTS digest_subscriptions_status_idx
  ON digest_subscriptions(status);
