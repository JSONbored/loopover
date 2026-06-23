-- Public OAuth draft-submission flow (REVIEWBOT_DRAFT), ported from reviewbot.
-- A contributor submits a draft -> a fork PR is opened against the upstream content repo.
-- Flag-gated: when REVIEWBOT_DRAFT is OFF the endpoints 404 and nothing writes here.
CREATE TABLE IF NOT EXISTS submission_drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'auth_required', -- auth_required | queued | pr_open | error
  category TEXT NOT NULL,
  slug TEXT NOT NULL,
  target_path TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  auth_state_hash TEXT,
  github_login TEXT,
  fork_full_name TEXT,
  pull_request_url TEXT,
  pull_request_number INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submission_drafts_status
  ON submission_drafts (status, updated_at);

CREATE TABLE IF NOT EXISTS submission_user_tokens (
  draft_id TEXT PRIMARY KEY,
  encrypted_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_id) REFERENCES submission_drafts (id)
);
