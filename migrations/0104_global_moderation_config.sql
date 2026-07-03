-- Global moderation-rules engine config (#selfhost-mod-engine): singleton row, mirroring
-- global_contributor_blacklist and global_agent_controls's shape (one row, id = 'singleton'). Off by default
-- (enabled = 0) -- zero behavior change for an install that hasn't opted in. rules_json is the DEFAULT set of
-- the three existing anti-abuse mechanisms (contributor cap, blacklist, review-nag) that count toward a
-- contributor's shared, cross-repo violation tally; a repo can override its own participating rules via
-- repository_settings.moderation_rules_json. violation_decay_days is nullable: null = a permanent, never-
-- decaying lifetime tally (the default, matching the existing global-blacklist's permanent-ban philosophy);
-- a positive integer = only violations within that many days count toward ban_threshold.
CREATE TABLE IF NOT EXISTS global_moderation_config (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT NOT NULL DEFAULT '["contributor_cap","blacklist","review_nag"]',
  warning_label TEXT NOT NULL DEFAULT 'mod:warning',
  banned_label TEXT NOT NULL DEFAULT 'mod:banned',
  ban_threshold INTEGER NOT NULL DEFAULT 5,
  violation_decay_days INTEGER,
  auto_blacklist_on_ban INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
INSERT OR IGNORE INTO global_moderation_config (id) VALUES ('singleton');
