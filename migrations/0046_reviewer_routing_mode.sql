-- #540/#830 reviewer-routing: add opt-in reviewer auto-request mode. `off` = feature disabled (default);
-- `advisory` = surface ranked CODEOWNERS suggestions in the PR panel only, no GitHub API side-effects;
-- `auto_request` = also call GitHub's request-reviewers API for the top suggestion (outward-facing,
-- never for first-time external contributors without explicit opt-in per #552).
ALTER TABLE repository_settings ADD COLUMN reviewer_routing_mode TEXT NOT NULL DEFAULT 'off';
