-- Opt-in oldest-first ordering mode for the scheduled re-gate sweep (#3815). Default 'staleness' (existing
-- behavior, unchanged) — a repo opts into 'oldest-first' explicitly via the dashboard/API or .gittensory.yml.
ALTER TABLE repository_settings ADD COLUMN regate_sweep_order_mode TEXT NOT NULL DEFAULT 'staleness';
