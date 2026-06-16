-- #699 path B: miners subscribe to watch a repo for NEW grabbable, high-multiplier issues. When such an
-- issue opens, the watchers are notified through the #535 notification pipeline. `labels_json` is an
-- optional label filter ([] = any label); UNIQUE(login, repo_full_name) makes subscribe idempotent.
CREATE TABLE IF NOT EXISTS issue_watch_subscriptions (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS issue_watch_subscriptions_login_repo_unique ON issue_watch_subscriptions (login, repo_full_name);
CREATE INDEX IF NOT EXISTS issue_watch_subscriptions_repo_idx ON issue_watch_subscriptions (repo_full_name);
