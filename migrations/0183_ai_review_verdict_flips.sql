-- #9016 (security): bound how many times an AI-review verdict can flip-flop for one PR before a human is
-- required. The AI reviewer is non-deterministic even at temperature 0; without a bound, a contributor can
-- force fresh re-rolls (a no-op recommit that invalidates the head-SHA cache key, or a same-head retry once
-- the non-cacheable cooldown lapses) until a lucky CLEAN roll auto-merges a PR other rolls flagged as
-- blocked. One row per (repo_full_name, pull_number) tracks the last FRESH (non-cache-hit) verdict's
-- defect/clean state and how many times it has flipped since; the escalation itself is computed in
-- src/review/verdict-flip-guard.ts (pure) and applied by the caller.
CREATE TABLE IF NOT EXISTS ai_review_verdict_flips (
  repo_full_name  TEXT NOT NULL,
  pull_number     INTEGER NOT NULL,
  last_had_defect INTEGER NOT NULL,   -- 0 | 1
  flip_count      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (repo_full_name, pull_number)
);
