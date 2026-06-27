-- Per-repo toggle: allow auto-closing the repo OWNER's/maintainer's own PRs (default 0 = exempt, the prior
-- hardwired behavior — owner PRs merge or hold for manual review, never auto-close). Configurable so maintainers
-- aren't locked into one opinion.
ALTER TABLE repository_settings ADD COLUMN close_owner_authors INTEGER NOT NULL DEFAULT 0;
