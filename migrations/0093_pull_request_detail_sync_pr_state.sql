ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN pr_mergeable_state TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN pr_state TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN pr_state_fetched_at TEXT;
