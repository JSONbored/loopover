-- Auto-project/milestone matching (#3185): per-repo confidence floor for auto-apply mode. NULL = use the
-- built-in default (65, matching the suggest-mode fuzzy-match bar). Opt-in repos can raise this before
-- flipping autoProjectMilestoneMatch to "auto".
ALTER TABLE repository_settings ADD COLUMN auto_project_milestone_match_threshold INTEGER;
