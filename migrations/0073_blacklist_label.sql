-- #1425: per-repo configurable label for a blacklisted contributor's PR/issue. Default "slop" so the
-- deterministic blacklist disposition works regardless of the label a repo uses.
ALTER TABLE repository_settings ADD COLUMN blacklist_label TEXT NOT NULL DEFAULT 'slop';
