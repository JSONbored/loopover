-- Orb relay failure queue (#relay-retry): when forwardOrbEvent fails (container down or returning an error),
-- the delivery is recorded here for periodic retry. The cron (retry-orb-relay job) re-attempts pending rows,
-- deletes on success, increments attempts on failure, and prunes expired rows (TTL = 1 hour).
-- `expires_at` is computed once at insert; `attempts` is bounded by the processor (max 5).
CREATE TABLE IF NOT EXISTS orb_relay_failures (
  delivery_id    TEXT    NOT NULL PRIMARY KEY,
  event_name     TEXT    NOT NULL,
  installation_id INTEGER NOT NULL,
  raw_body       TEXT    NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT    NOT NULL DEFAULT (datetime('now', '+1 hour'))
);
