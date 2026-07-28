-- #9472/#9473: 0193 gave every RETENTION_POLICY table of its era a leading-column index on its retention
-- timestamp, so each batched delete's inner SELECT is an index range scan rather than a full table scan.
-- Two later batches of policy entries never got the same treatment:
--
--   * #9415's five (check_summaries, pull_request_files, repo_github_totals_snapshots,
--     recent_merged_pull_requests, orb_pr_outcomes) shipped with no migration at all, while also moving the
--     prune to HOURLY. check_summaries (511MB / 180,820 rows) and pull_request_files (179MB / 63,091 rows)
--     were measured as the two largest tables in the production database, so this was a full scan + sort of
--     both, every hour -- and on the synchronous SQLite adapter that blocks the event loop.
--   * #9473's four newly-bounded per-event tables, added alongside this migration.
--
-- Paired with the RETENTION_PK_COLUMN entries added in the same change (without which pkColumnFor() falls
-- back to `rowid` -> `ctid` on Postgres, making the outer `IN` a seq scan regardless of this index).
CREATE INDEX IF NOT EXISTS idx_check_summaries_updated_at ON check_summaries(updated_at);
CREATE INDEX IF NOT EXISTS idx_pull_request_files_updated_at ON pull_request_files(updated_at);
CREATE INDEX IF NOT EXISTS idx_repo_github_totals_snapshots_fetched_at ON repo_github_totals_snapshots(fetched_at);
CREATE INDEX IF NOT EXISTS idx_recent_merged_pull_requests_updated_at ON recent_merged_pull_requests(updated_at);
CREATE INDEX IF NOT EXISTS idx_orb_pr_outcomes_occurred_at ON orb_pr_outcomes(occurred_at);
CREATE INDEX IF NOT EXISTS idx_pull_request_reviews_updated_at ON pull_request_reviews(updated_at);
CREATE INDEX IF NOT EXISTS idx_predicted_gate_calibration_ledger_created_at ON predicted_gate_calibration_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_contributor_gate_history_created_at ON contributor_gate_history(created_at);
CREATE INDEX IF NOT EXISTS idx_decision_replay_inputs_created_at ON decision_replay_inputs(created_at);
