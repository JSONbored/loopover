-- #8820 (reuse-rate half): live fleet source for the homepage "AI work reused" trend.
--
-- The public reuse-rate trend reads github_app.%cache_hit/%cache_miss audit events from THIS worker's own
-- ledger — which froze at the self-host cutover (last event 2026-06-29), so the latest weekly buckets fell
-- under the publish floor and the hero tile rendered a dash next to a decaying sparkline. The live signal
-- (133k+ cache events and growing) accrues on the self-hosted instances; this table receives their
-- day-bucketed, instance-level aggregate counters (counts only — no repos, no PRs, no content), exported on
-- the same hourly tick as orb_signals and folded into the public trend for REGISTERED instances only (the
-- same trust anchor computeFleetAnalytics uses).
CREATE TABLE IF NOT EXISTS orb_reuse_counters (
  instance_id TEXT    NOT NULL,
  day         TEXT    NOT NULL, -- YYYY-MM-DD (UTC)
  hits        INTEGER NOT NULL DEFAULT 0,
  misses      INTEGER NOT NULL DEFAULT 0,
  received_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (instance_id, day) -- senders re-export a rolling window; the upsert keeps the freshest counts
);
