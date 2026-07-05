-- Per-repo overrides for the moderation-rules engine (#selfhost-mod-engine), layered over
-- global_moderation_config (0104). moderation_gate_mode defaults to 'inherit' (defers to the global master
-- switch) -- 'off' lets one repo opt out while the global layer is enabled; 'enabled' explicitly opts
-- into the globally enabled layer but cannot override the install-wide master switch. The three
-- override columns are nullable: NULL means "inherit the global value", never "unset to empty/off" -- an
-- explicit repo-level empty rules list would be indistinguishable from "not configured" otherwise.
ALTER TABLE repository_settings ADD COLUMN moderation_gate_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE repository_settings ADD COLUMN moderation_rules_json TEXT;
ALTER TABLE repository_settings ADD COLUMN moderation_warning_label TEXT;
ALTER TABLE repository_settings ADD COLUMN moderation_banned_label TEXT;
