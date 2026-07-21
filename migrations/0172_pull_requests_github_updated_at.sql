-- Out-of-order webhook guard (#webhook-reorder-clobber): a webhook queued behind a slow/congested job can be
-- processed AFTER a later event for the same PR already landed and applied a newer state -- its embedded PR
-- snapshot is then stale and must not regress lifecycle-identity fields (state/headSha/mergedAt) GitHub has
-- already moved past. This column stores GitHub's OWN `updated_at` for the PR (distinct from `updated_at`,
-- which is app bookkeeping) so upsertPullRequestFromGitHub can compare incoming vs. stored before applying a
-- write. NULL for every existing row -- the guard fails open (applies the write) whenever it has nothing to
-- compare against, so this backfills itself the next time each PR is synced.
ALTER TABLE pull_requests ADD COLUMN github_updated_at TEXT;
