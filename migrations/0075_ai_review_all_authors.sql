-- AI review for all authors (per-repo opt-in). The AI maintainer review is confirmed-contributor-gated by
-- default (an AI-spend guard, see runAiReviewForAdvisory). `ai_review_all_authors` lets a self-host operator
-- run the review for EVERY PR's author — intended for an operator who wants real reviews on all PRs (incl. their
-- own) and pays for the AI themselves. Default 0 (off) — additive, existing repos are byte-identical.
ALTER TABLE repository_settings ADD COLUMN ai_review_all_authors INTEGER NOT NULL DEFAULT 0;
