-- Gittensory Orb (#1219): tracks which repos have the Orb GitHub App installed.
-- `removed_at IS NULL` = currently installed; set on uninstall/removal events.
CREATE TABLE IF NOT EXISTS orb_installations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  repo            TEXT    NOT NULL,
  installed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  removed_at      TEXT,             -- NULL = still installed
  UNIQUE (installation_id, repo)
);
CREATE INDEX IF NOT EXISTS orb_installations_repo ON orb_installations (repo, removed_at);
