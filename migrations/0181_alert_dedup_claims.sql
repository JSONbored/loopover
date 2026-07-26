-- #8901: src/review/alerts.ts's runAnomalyAlerts (the anomaly-alert port) writes hourly dedup CLAIMS with the
-- shape (id, project, target_id, notification_key, status) and ON CONFLICT(project, target_id, notification_key)
-- DO NOTHING. It was pointing those raw INSERTs at `notification_deliveries` (migration 0031), whose real schema
-- has none of those columns and no such unique constraint — so the moment runAnomalyAlerts is wired to a cron
-- path, its first INSERT throws. This gives the port its own correctly-shaped table with the real unique index
-- it needs, independent of whether it is ever wired.
CREATE TABLE IF NOT EXISTS alert_dedup_claims (
  id                TEXT PRIMARY KEY,   -- opaque claim id (newId("hc")/newId("anm"))
  project           TEXT NOT NULL,      -- agent slug
  target_id         TEXT NOT NULL,      -- '__healthcheck__' or '__anomaly__'
  notification_key  TEXT NOT NULL,      -- hashed per-hour / per-condition-set key
  status            TEXT NOT NULL DEFAULT 'sent',
  -- The claim mechanism relies on this exact unique constraint: the ON CONFLICT(...) DO NOTHING lets exactly one
  -- writer per (project, target_id, notification_key) win the hourly claim; the losers see zero changed rows.
  UNIQUE (project, target_id, notification_key)
);
