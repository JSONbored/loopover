-- Per-repo contributor blacklist (#1425, anti-abuse): a JSON array of banned-login entries
-- ({ login, reason?, evidence?, addedAt? }) the converged engine deterministically closes a PR/issue against,
-- ahead of any merit/CI/AI analysis. Layered like other settings (.gittensory.yml > DB) and unioned with the
-- shared/global list at the point of use. Defaults to an empty list, so existing rows are byte-identical.
ALTER TABLE repository_settings ADD COLUMN contributor_blacklist_json TEXT NOT NULL DEFAULT '[]';
