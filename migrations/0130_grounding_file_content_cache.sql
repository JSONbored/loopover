-- Grounding file-content cache (#4499): makeGithubFileFetcher re-fetches every changed file's FULL post-change
-- body from GitHub on every invocation with zero caching -- content for a given (repo, path, head_sha) triple
-- is a git blob at an immutable commit, so it genuinely never changes and is safe to cache durably, not just
-- with a short TTL, mirroring linked_issue_satisfaction_cache (migration 0124). Keyed WITHOUT a pull number
-- (unlike that cache): file content at a given head SHA is universal, not PR-specific, so two PRs that happen
-- to share a (repo, path, head_sha) triple (e.g. a cherry-pick) correctly share one cached row. Only a
-- SUCCESSFUL fetch is ever stored -- a transient network/timeout failure must not be cached as if it were a
-- confirmed-permanent condition (binary/oversized/inaccessible), or a later retry would wrongly skip forever.
CREATE TABLE IF NOT EXISTS grounding_file_content_cache (
  repo_full_name TEXT NOT NULL,
  path TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  content TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_full_name, path, head_sha)
);
