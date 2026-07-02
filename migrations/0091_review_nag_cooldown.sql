-- Review-request nagging cooldown (#2463, anti-abuse): throttle a contributor repeatedly pinging @gittensory.
-- Defaults are byte-identical to today: review_nag_policy defaults to 'off' (disabled), so existing rows see no
-- behavior change. review_nag_max_pings / review_nag_cooldown_days / review_nag_label only take effect once a
-- repo opts in by setting the policy to 'hold' or 'close'.
ALTER TABLE repository_settings ADD COLUMN review_nag_policy TEXT NOT NULL DEFAULT 'off';
ALTER TABLE repository_settings ADD COLUMN review_nag_max_pings INTEGER NOT NULL DEFAULT 3;
ALTER TABLE repository_settings ADD COLUMN review_nag_cooldown_days INTEGER NOT NULL DEFAULT 5;
ALTER TABLE repository_settings ADD COLUMN review_nag_label TEXT NOT NULL DEFAULT 'review-nag-cooldown';
-- Shared repo-scoped exemption list (#2463): GitHub logins never throttled/closed by gittensory's deterministic
-- anti-abuse mechanisms, on top of the standing owner/admin/automation-bot exemption. Defaults to an empty list.
ALTER TABLE repository_settings ADD COLUMN auto_close_exempt_logins_json TEXT NOT NULL DEFAULT '[]';
