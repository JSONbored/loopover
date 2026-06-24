-- Global agent kill-switch (#audit-§5.2). A DB-backed emergency brake an operator can flip with one row
-- (no redeploy), complementing the env-var AGENT_ACTIONS_PAUSED hard backstop. `frozen = 1` halts ALL agent
-- write actions across every repo within ~one evaluation cycle. Singleton: exactly one row, id = 'singleton'.
CREATE TABLE IF NOT EXISTS global_agent_controls (
  id         TEXT PRIMARY KEY,
  frozen     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT
);
INSERT OR IGNORE INTO global_agent_controls (id, frozen) VALUES ('singleton', 0);
