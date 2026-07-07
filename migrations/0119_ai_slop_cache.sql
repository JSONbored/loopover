-- AI slop advisory cache (mirrors ai_review_cache, #74/#98/#112): runGittensoryAiSlopAdvisory makes a real
-- LLM call (up to 6 free-tier attempts, or one BYOK call) with NO caching, so every scheduled re-gate sweep
-- tick re-spends it for every open PR with slopAiAdvisory on, even at an unchanged head SHA -- confirmed in
-- production: 1,469 ai_slop_pr calls in 24h across 3 repos, 110 of them on a single PR. Unlike ai_review_cache,
-- the slop advisory has no dynamic-context dimension (no RAG/grounding/enrichment/reputation feed into it --
-- see ai-slop.ts's AiSlopInput) and nothing analogous to a "published" GitHub artifact to protect against
-- replaying: its output is folded into the SAME advisory pass that (re)computes it, never stamped separately.
-- So this cache is unconditionally durable for a given (repo, pull, head SHA) -- no cacheable/published_at
-- cooldown columns needed, deliberately simpler than ai_review_cache.
CREATE TABLE IF NOT EXISTS ai_slop_cache (
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  -- Fingerprints the one input that can change independently of the head SHA: which provider produced the
  -- opinion (free/default reviewer vs. a maintainer's BYOK key/model). Title/body/diff/deterministicBand are
  -- all already pinned to the head SHA (see getReviewFiles/buildAiReviewDiff), so they need no fingerprinting.
  input_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  band TEXT,
  finding_json TEXT,
  estimated_neurons INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_full_name, pull_number, head_sha)
);
