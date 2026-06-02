CREATE TABLE IF NOT EXISTS github_agent_command_answers (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  command TEXT NOT NULL,
  request_comment_id INTEGER,
  response_comment_id INTEGER,
  response_url TEXT,
  actor_kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS github_agent_command_answers_repo_issue_idx
  ON github_agent_command_answers(repo_full_name, issue_number);

CREATE INDEX IF NOT EXISTS github_agent_command_answers_command_updated_idx
  ON github_agent_command_answers(command, updated_at);

CREATE TABLE IF NOT EXISTS github_agent_command_feedback (
  id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  command TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  vote TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(answer_id) REFERENCES github_agent_command_answers(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS github_agent_command_feedback_actor_answer_unique
  ON github_agent_command_feedback(answer_id, actor_hash);

CREATE INDEX IF NOT EXISTS github_agent_command_feedback_command_updated_idx
  ON github_agent_command_feedback(command, updated_at);

CREATE INDEX IF NOT EXISTS github_agent_command_feedback_repo_issue_idx
  ON github_agent_command_feedback(repo_full_name, issue_number);
