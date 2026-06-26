-- #1 (self-host perf): cache the expensive AI review by (repo, pull, head_sha) so a re-delivered webhook and the
-- block-mode ~2-min re-gate sweep (which re-runs the AI for every open PR) don't re-spend the LLM call for the same
-- commit. The deterministic gate still re-evaluates every time; only the AI leg is reused. A new head SHA (new code)
-- or a changed review mode invalidates the entry. On self-host there is no AI gateway, so this is the only AI cache.
CREATE TABLE IF NOT EXISTS ai_review_cache (
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  ai_review_mode TEXT NOT NULL,
  notes TEXT NOT NULL,
  reviewer_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_full_name, pull_number, head_sha)
);
