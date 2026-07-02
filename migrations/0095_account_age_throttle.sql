-- Account-age throttle (#2561, anti-abuse): a friction/visibility signal for the classic ban-evasion pattern
-- (a banned login gets a fresh account the same day). Defaults are byte-identical to today:
-- account_age_threshold_days defaults to NULL (off), so existing repos see no behavior change until they
-- configure a threshold. Never auto-closes on account age alone -- label and/or a tighter effective cap only.
ALTER TABLE repository_settings ADD COLUMN account_age_threshold_days INTEGER;
ALTER TABLE repository_settings ADD COLUMN new_account_label TEXT NOT NULL DEFAULT 'new-account';
