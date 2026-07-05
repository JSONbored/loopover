ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_head_sha TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_state TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_has_pending INTEGER;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_has_visible_pending INTEGER;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_has_missing_required_context INTEGER;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_failing_details_json TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_non_required_failing_details_json TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_completeness_warning TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_required_contexts_key TEXT;

ALTER TABLE pull_request_detail_sync_state
  ADD COLUMN ci_state_fetched_at TEXT;
