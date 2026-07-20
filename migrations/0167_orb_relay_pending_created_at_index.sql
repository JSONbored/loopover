-- pruneRelayPending (src/orb/relay.ts) runs a fleet-wide TTL sweep filtered ONLY by created_at (not scoped to
-- one installation_id), on every orb-relay-drain pull (#7430). Both existing indexes on this table lead with
-- installation_id, so that predicate couldn't use either one -- the SELECT and DELETE both fell back to a
-- full table scan, occasionally exceeding the pull request's 30s timeout budget.
CREATE INDEX IF NOT EXISTS idx_orb_relay_pending_created_at ON orb_relay_pending (created_at);
