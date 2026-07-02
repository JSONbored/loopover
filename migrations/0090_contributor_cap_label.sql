-- Label applied to a PR/issue closed for exceeding a per-contributor open-item cap (#2270, anti-abuse).
-- Configurable so the disposition works regardless of the label a repo sets; defaults to "over-contributor-limit"
-- so existing rows are byte-identical to the enforcement's built-in fallback.
ALTER TABLE repository_settings ADD COLUMN contributor_cap_label TEXT NOT NULL DEFAULT 'over-contributor-limit';
