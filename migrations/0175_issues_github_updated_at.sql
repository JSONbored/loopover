-- #8804 (round-2 audit): extend the out-of-order webhook guard (#webhook-reorder-clobber, 0172) to ISSUES.
-- upsertIssueFromGitHub had no reorder protection at all -- a delayed webhook's stale snapshot could regress
-- an issue's state and wipe a just-applied label. Same design as pull_requests.github_updated_at: stores
-- GitHub's OWN `updated_at` so the upsert can compare incoming vs. stored; NULL for existing rows -- the
-- guard fails open until each issue's next sync backfills it.
ALTER TABLE issues ADD COLUMN github_updated_at TEXT;
