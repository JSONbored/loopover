-- Agent-layer approval queue (#779, Wave 2 Phase 1). When an action's autonomy level is `auto_with_approval`,
-- the maintainer write-actions layer (#778) STAGES it here instead of executing. The maintainer accepts (→
-- execute) or rejects (→ cancel) it in one tap, and that decision feeds the trust loop. At most one row per
-- (repo, pull, action_class): re-evaluation never duplicates a staged action, and a decided row is sticky.
CREATE TABLE IF NOT EXISTS agent_pending_actions (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  action_class TEXT NOT NULL,
  autonomy_level TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_pending_actions_target_unique ON agent_pending_actions (repo_full_name, pull_number, action_class);
CREATE INDEX IF NOT EXISTS agent_pending_actions_repo_status_idx ON agent_pending_actions (repo_full_name, status, created_at);
