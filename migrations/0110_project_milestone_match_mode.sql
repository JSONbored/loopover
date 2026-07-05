-- Auto-project/milestone matching (#3183): detects when a PR is likely part of an open GitHub Milestone even
-- with no closing-keyword issue link, and posts a bot-comment suggestion in "suggest" mode. Defaults to 'off'
-- (opt-in) -- no existing repo should start getting suggestion comments without an explicit choice.
ALTER TABLE repository_settings ADD COLUMN project_milestone_match_mode TEXT NOT NULL DEFAULT 'off';
