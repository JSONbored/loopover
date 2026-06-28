-- Shared/global contributor blacklist (#1425): singleton row consumed during settings resolution.
-- This acts like `global_agent_controls`: one row, id = 'singleton', to avoid repo-by-repo duplication.
CREATE TABLE IF NOT EXISTS global_contributor_blacklist (
  id TEXT PRIMARY KEY,
  contributor_blacklist_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
INSERT OR IGNORE INTO global_contributor_blacklist (id, contributor_blacklist_json) VALUES ('singleton', '[]');
