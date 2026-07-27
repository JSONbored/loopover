-- Pull-mode drain isolation (#9150): orb_relay_pending was scoped only by installation_id, so ANY enrollment
-- secret valid for an installation could drain and destructively-ack another live consumer's queued webhooks
-- (a stale re-enrolled container silently stealing a fresh one's events). This column lets an enqueue tag
-- which enrollment a GitHub-webhook row was queued for (the same "winning enrollment" forwardOrbEvent already
-- picks for the push path, #1783); NULL for every existing row and for config_push notices (which remain
-- intentionally installation-wide, not consumer-specific -- see enqueueConfigPushRelay). NULL also means "not
-- yet tagged", so pullRelayPending's WHERE clause matches untagged rows regardless of which enrollment asks --
-- a safe default during rollout, not a bypass (an enrollment can only ever add matches, never lose ones scoped
-- to a DIFFERENT enroll_id).
ALTER TABLE orb_relay_pending ADD COLUMN enroll_id TEXT;
CREATE INDEX IF NOT EXISTS idx_orb_relay_pending_enroll ON orb_relay_pending (installation_id, enroll_id);
