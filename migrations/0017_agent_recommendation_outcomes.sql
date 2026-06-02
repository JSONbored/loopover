CREATE TABLE IF NOT EXISTS agent_recommendation_outcomes (
  id TEXT PRIMARY KEY NOT NULL,
  action_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_login TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_repo_full_name TEXT,
  target_pull_number INTEGER,
  target_issue_number INTEGER,
  outcome_state TEXT NOT NULL,
  outcome_target_type TEXT NOT NULL,
  outcome_repo_full_name TEXT,
  outcome_pull_number INTEGER,
  outcome_issue_number INTEGER,
  maintainer_lane INTEGER NOT NULL DEFAULT 0,
  confidence TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_updated_at TEXT,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(action_id) REFERENCES agent_actions(id),
  FOREIGN KEY(run_id) REFERENCES agent_runs(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_recommendation_outcomes_action_unique
  ON agent_recommendation_outcomes(action_id);

CREATE INDEX IF NOT EXISTS agent_recommendation_outcomes_actor_state_idx
  ON agent_recommendation_outcomes(actor_login, outcome_state, updated_at);

CREATE INDEX IF NOT EXISTS agent_recommendation_outcomes_target_idx
  ON agent_recommendation_outcomes(target_repo_full_name, target_pull_number, target_issue_number);

CREATE INDEX IF NOT EXISTS agent_recommendation_outcomes_maintainer_idx
  ON agent_recommendation_outcomes(actor_login, maintainer_lane, updated_at);
