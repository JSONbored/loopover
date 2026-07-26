-- Dedicated dedup-claim store for the anomaly-alerter (#8901). src/review/alerts.ts's
-- `runAnomalyAlerts` throttles Discord alerts by INSERT ... ON CONFLICT(project, target_id,
-- notification_key) DO NOTHING against a claim table whose columns are (project, target_id,
-- notification_key) — a completely different shape than the migrated `notification_deliveries`
-- badge read-model (dedup_key/channel/recipient_login/...). The port was written against
-- `notification_deliveries` by name, so the moment it's wired to a cron path it would throw on its
-- first INSERT (no such columns / no such unique constraint). Give it its own table with the exact
-- (project, target_id, notification_key) unique index its ON CONFLICT target needs.
CREATE TABLE IF NOT EXISTS alert_dedup_claims (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  target_id TEXT NOT NULL,
  notification_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX alert_dedup_claims_project_target_key_unique
  ON alert_dedup_claims(project, target_id, notification_key);
