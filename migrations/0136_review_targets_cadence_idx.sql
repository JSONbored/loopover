-- Supports the submission-cadence signal (#4514): getSubmitterCadence queries ALL review_targets rows (not
-- just terminal ones -- a fresh burst of still-open submissions is exactly what this needs to catch) filtered
-- by (project, submitter, created_at). This shape isn't covered by the existing review_targets indexes
-- (migrations/0050), which are keyed on status/verdict/terminal_at, not created_at alongside submitter.
CREATE INDEX IF NOT EXISTS idx_review_targets_project_submitter_created ON review_targets (project, submitter, created_at);
