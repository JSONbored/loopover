-- Gittensory Orb central GitHub App (#1255) — terminal pull-request outcomes (merged | closed) observed via
-- the central App's webhook. The raw material for the global "proof of power" homepage counter (total merged /
-- closed across ALL registered maintainer repos, das-github-mirror style). Aggregated only over REGISTERED
-- installations. Idempotent on (repo, pr_number): a redelivery or a reopen→close cycle overwrites the latest
-- terminal state. occurred_at is always written explicitly (CURRENT_TIMESTAMP in VALUES); the column default is
-- a fallback only.
CREATE TABLE IF NOT EXISTS orb_pr_outcomes (
  repository_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  installation_id INTEGER,
  outcome TEXT NOT NULL,                       -- 'merged' | 'closed'
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (repository_full_name, pr_number)
);
CREATE INDEX IF NOT EXISTS orb_pr_outcomes_installation_idx ON orb_pr_outcomes(installation_id);
CREATE INDEX IF NOT EXISTS orb_pr_outcomes_outcome_idx ON orb_pr_outcomes(outcome);
