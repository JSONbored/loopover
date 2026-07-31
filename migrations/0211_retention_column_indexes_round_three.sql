-- #10058: submitter_outcome_log and alert_dedup_claims gained a RETENTION_POLICY entry in the same change,
-- following 0193/0196's precedent of pairing every new policy table with a leading-column index on its
-- retention timestamp so the batched delete's inner SELECT is an index range scan rather than a full scan.
CREATE INDEX IF NOT EXISTS idx_submitter_outcome_log_recorded_at ON submitter_outcome_log(recorded_at);
CREATE INDEX IF NOT EXISTS idx_alert_dedup_claims_created_at ON alert_dedup_claims(created_at);
