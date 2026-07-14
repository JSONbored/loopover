-- Waste elimination for known automation authors (github-actions[bot]/release-please, Renovate,
-- Dependabot -- settings/agent-actions.ts's PROTECTED_AUTOCLOSE_AUTHORS): skip AI review, gate evaluation,
-- and public-surface publish entirely for a PR genuinely triggered by one of these, not just suppress
-- output like review.auto_review.ignore_authors already does. 'inherit' (default) defers to the
-- LOOPOVER_SKIP_AUTOMATION_BOT_PRS global default (itself default-ON); 'off'/'enabled' fully override
-- the global default in either direction for this repo. Mirrors moderation_gate_mode's inherit/off/enabled
-- shape (0105).
ALTER TABLE repository_settings ADD COLUMN skip_automation_bot_authors TEXT NOT NULL DEFAULT 'inherit';
