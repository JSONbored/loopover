-- #541: opt-in flag for the public README status badge. Default 0 (off) — the unauthenticated badge
-- endpoint only serves whitelisted metrics for installed repos that have explicitly opted in.
ALTER TABLE repository_settings ADD COLUMN badge_enabled INTEGER NOT NULL DEFAULT 0;
