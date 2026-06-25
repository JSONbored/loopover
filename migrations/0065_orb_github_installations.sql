-- Gittensory Orb central GitHub App (#1255) — installation registry. One row per install of the shared Orb
-- App, maintained from the verified /v1/orb/webhook installation events. This is what onboarding + the
-- token-broker (later PRs) read to know which installations exist, who owns them, and whether an operator has
-- registered them. registered=0 by default — the Mirror-style manual-onboarding gate (an install is RECORDED
-- but does not count / activate until a human opts it in), mirroring #1274's orb_instances trust model.
CREATE TABLE IF NOT EXISTS orb_github_installations (
  installation_id INTEGER PRIMARY KEY NOT NULL,
  account_login TEXT,           -- the org/user the App is installed on
  account_type TEXT,            -- 'Organization' | 'User'
  repository_selection TEXT,    -- 'all' | 'selected'
  registered INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT,            -- set on 'suspend', cleared on 'unsuspend'
  removed_at TEXT,              -- set on 'deleted' (kept for audit rather than hard-deleted)
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_event_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS orb_github_installations_registered_idx ON orb_github_installations(registered);
