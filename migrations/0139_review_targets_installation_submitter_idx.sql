-- Supports the install-wide submitter-reputation read (#4513): a fleet identity spreading thin across many
-- repos in one self-hosted install never accumulates enough same-repo sample density for the per-repo
-- reputation signal (src/review/submitter-reputation.ts) to ever fire, since that signal is scoped to
-- `WHERE project = ? AND submitter = ?`. review_targets already carries installation_id (migrations/0050),
-- so a CONFIRMED official Gittensor miner can additionally be evaluated across every repo in the same
-- install via `WHERE installation_id = ? AND submitter = ?` -- this index makes that query as cheap as the
-- existing per-project one instead of a full-table scan.
CREATE INDEX IF NOT EXISTS idx_review_targets_installation_submitter_terminal ON review_targets (installation_id, submitter, terminal_at);
