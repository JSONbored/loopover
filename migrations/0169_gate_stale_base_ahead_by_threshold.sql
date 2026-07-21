-- Stale-base auto-rebase threshold (#review-grounding stale-base fact): optional per-repo commit-count
-- threshold. NULL (the default) means this path never forces a rebase -- byte-identical behavior for every
-- existing row. When set, the pre-review readiness gate forces an update_branch whenever the repo's current
-- default branch is at least this many commits ahead of a PR's own base commit, independent of GitHub's own
-- mergeable_state "behind" signal (which only fires when the repo's branch protection requires branches to be
-- up to date before merging).
ALTER TABLE repository_settings ADD COLUMN stale_base_ahead_by_threshold INTEGER;
