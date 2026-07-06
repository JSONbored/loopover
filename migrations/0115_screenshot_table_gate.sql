-- Config-driven before/after screenshot-table gate (#2006): a contributor visual/frontend PR that lacks a
-- before/after screenshot table in its body is unreviewable at a glance. This mechanism was previously
-- documented-only (the contributing skill / PR template); this migration makes it a per-repo, config-as-code
-- gate, layered the same way as every other anti-abuse mechanism in this file (blacklist/review-nag/
-- review-evasion): off by default (zero behavior change for an install that hasn't opted in),
-- `screenshot_table_gate_action` NOT NULL with a "close" default (mirrors the existing hard requirement), and
-- the label/path scope lists stored as JSON (mirrors contributor_blacklist_json / auto_close_exempt_logins_json).
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_when_labels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_when_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_action TEXT NOT NULL DEFAULT 'close';
-- Nullable: null = use the built-in default templated contract message (DEFAULT_SCREENSHOT_CONTRACT_MESSAGE),
-- never "unset to empty" (mirrors moderation_rules_json's null-means-inherit-default shape).
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_message TEXT;
