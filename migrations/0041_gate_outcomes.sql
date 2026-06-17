-- #554 gate false-positive telemetry: one latest gate-block row per (repo, PR). MEASUREMENT only — it lets a
-- maintainer compute a per-gate-type false-positive rate (blocked-then-merged / blocked) as the evidence
-- needed before promoting a gate from advisory to block. Privacy: repo full name + PR number + blocker
-- codes + timestamps ONLY — no actor logins, no trust/reward internals. Mirrors agent_recommendation_outcomes.
CREATE TABLE IF NOT EXISTS gate_outcomes (
  id TEXT PRIMARY KEY NOT NULL,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT,
  blocker_codes_json TEXT NOT NULL DEFAULT '[]',
  overridden INTEGER NOT NULL DEFAULT 0,
  blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS gate_outcomes_pr_unique
  ON gate_outcomes(repo_full_name, pull_number);

CREATE INDEX IF NOT EXISTS gate_outcomes_repo_updated_idx
  ON gate_outcomes(repo_full_name, updated_at);
