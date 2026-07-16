-- Config-as-code migration (loopover#6445/epic #6440): these 19 fields already parse correctly from
-- .loopover.yml's settings: block (confirmed via audit; none are sparse-merge composites, so
-- resolveEffectiveSettings needs no special-casing -- they overlay via the generic
-- {...dbSettings, ...restManifestSettings} spread, same as autoMaintain/commandAuthorization already do).
-- Same dead-column-cleanup shape as the prior Batch A (0157) and Batch B (0158) migrations in this epic.
-- SQLite 3.35+ / D1 supports DROP COLUMN directly.
--
-- agentPaused/agentDryRun (incident kill-switches) and requireFreshRebaseWindowMinutes are explicitly
-- OUT of scope for this migration and stay DB-only -- see the issue body / schema.ts comments.
ALTER TABLE repository_settings DROP COLUMN project_milestone_match_mode;
ALTER TABLE repository_settings DROP COLUMN auto_project_milestone_match_backend;
ALTER TABLE repository_settings DROP COLUMN auto_maintain_json;
ALTER TABLE repository_settings DROP COLUMN contributor_open_pr_cap;
ALTER TABLE repository_settings DROP COLUMN contributor_open_issue_cap;
ALTER TABLE repository_settings DROP COLUMN contributor_cap_label;
ALTER TABLE repository_settings DROP COLUMN contributor_cap_cancel_ci;
ALTER TABLE repository_settings DROP COLUMN review_nag_policy;
ALTER TABLE repository_settings DROP COLUMN review_nag_max_pings;
ALTER TABLE repository_settings DROP COLUMN review_nag_cooldown_days;
ALTER TABLE repository_settings DROP COLUMN review_nag_label;
ALTER TABLE repository_settings DROP COLUMN review_nag_monitored_mentions_json;
ALTER TABLE repository_settings DROP COLUMN auto_close_exempt_logins_json;
ALTER TABLE repository_settings DROP COLUMN account_age_threshold_days;
ALTER TABLE repository_settings DROP COLUMN new_account_label;
ALTER TABLE repository_settings DROP COLUMN command_rate_limit_policy;
ALTER TABLE repository_settings DROP COLUMN command_rate_limit_max_per_window;
ALTER TABLE repository_settings DROP COLUMN command_rate_limit_ai_max_per_window;
ALTER TABLE repository_settings DROP COLUMN command_rate_limit_window_hours;
