-- Per-repo overrides for the moderation-rules engine (#selfhost-mod-engine), layered over
-- global_moderation_config (0103). moderation_gate_mode defaults to 'inherit' (defers to the global master
-- switch) -- 'off'/'enabled' let one repo opt out of or into the whole layer regardless of the global default,
-- e.g. an operator piloting the feature on a single repo before flipping the global default on. The three
-- override columns are nullable: NULL means "inherit the global value", never "unset to empty/off" -- an
-- explicit repo-level empty rules list would be indistinguishable from "not configured" otherwise.
ALTER TABLE repository_settings ADD COLUMN moderation_gate_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE repository_settings ADD COLUMN moderation_rules_json TEXT;
ALTER TABLE repository_settings ADD COLUMN moderation_warning_label TEXT;
ALTER TABLE repository_settings ADD COLUMN moderation_banned_label TEXT;
