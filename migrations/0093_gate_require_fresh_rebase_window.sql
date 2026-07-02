-- Force-rebase-before-merge gate (#2552): optional per-repo window (minutes). NULL (the default) means the
-- gate never forces a rebase -- byte-identical behavior for every existing row. When set, an agent-driven
-- merge whose base branch advanced within this window forces an update_branch + fresh CI recheck before
-- merging, instead of trusting a mergeable_state: clean read that may already be stale relative to the base.
ALTER TABLE repository_settings ADD COLUMN require_fresh_rebase_window_minutes INTEGER;
