-- CI-run cancellation on a contributor_cap close (#2462): nullable, not NOT NULL DEFAULT 0 -- null means
-- "unset", distinct from an explicit false, so the CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT env var can act as the
-- fallback only when a repo hasn't configured this. Existing repos see no behavior change until either the
-- repo opts in or the operator sets the global env default, AND the App installation has granted actions:write.
ALTER TABLE repository_settings ADD COLUMN contributor_cap_cancel_ci INTEGER;
