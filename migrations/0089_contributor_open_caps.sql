-- Per-contributor open PR/issue caps (#2270, anti-abuse): optional per-repo ceilings on how many PRs/issues a
-- single contributor may have open at once. NULL (the default) means no cap — byte-identical behavior for every
-- existing row. Enforcement (auto-close over the cap) lands in a follow-up PR; this column only carries config.
ALTER TABLE repository_settings ADD COLUMN contributor_open_pr_cap INTEGER;
ALTER TABLE repository_settings ADD COLUMN contributor_open_issue_cap INTEGER;
