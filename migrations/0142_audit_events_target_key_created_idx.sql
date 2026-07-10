-- Supports an efficient "find every audit_events row for this target (PR)" lookup (#4723): without this,
-- src/services/public-review-volume-trend.ts's weekly review-volume cohort query had to scan the entire
-- github_app.pr_public_surface_published history to find each PR's true first-publish date, growing
-- unboundedly with the whole table instead of staying proportional to the trailing trend window. target_key
-- is not unique per row (one PR accumulates one row per lifecycle event: publish, close, merge, ...), so this
-- is a lookup index, not a uniqueness constraint.
CREATE INDEX IF NOT EXISTS audit_events_target_key_created_idx ON audit_events (target_key, created_at);
