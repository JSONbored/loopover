-- RC3 (terminal-fail merges): stop the auto-maintain merge retry-forever loop.
--
-- BEFORE: executeAgentMaintenanceActions() calls mergePullRequest(); a 403 (Resource not accessible) / 405
-- (method not allowed) / 409 (required check absent) / conflict throws, the action is recorded as an `error`
-- audit row, but the pull_requests row stays plannable — so EVERY webhook + every scheduled re-gate sweep
-- re-plans the same merge and it fails again, with no cap and no backoff. (reviewbot parity: review_targets'
-- attempt_count + terminal_at, which gittensory's normalized planner path never had.)
--
-- AFTER: a non-transient merge failure marks the PR terminally merge-blocked FOR THE CURRENT HEAD SHA. The
-- planner skips planning a merge while merge_blocked_sha == headSha, and the executor caps retries via
-- merge_attempt_count so even a misclassified transient failure escalates to a human instead of looping.
--
-- merge_blocked_sha is keyed to the head SHA so a NEW commit (which upsertPullRequestFromGitHub writes) clears
-- the block automatically — a pushed fix gets a fresh merge attempt without any manual reset.
--
-- pull_requests IS a Drizzle table (src/db/schema.ts), so these columns are added to the Drizzle schema too;
-- this raw migration is the production DDL applied by `wrangler d1 migrations apply` (drizzle-kit is not the
-- runtime migrator here).
ALTER TABLE pull_requests ADD COLUMN merge_attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_requests ADD COLUMN merge_blocked_sha TEXT;
ALTER TABLE pull_requests ADD COLUMN merge_blocked_reason TEXT;
