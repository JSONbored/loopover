-- Typed config-push write path (#7522, piece 1 of #4902's design): a discriminator so the pull-drain loop can
-- stop assuming every orb_relay_pending row is a GitHub webhook. Default preserves identical behavior for every
-- existing and future GitHub-webhook row -- dispatch behavior itself is unchanged by this migration (see the
-- companion dispatch-side issue #7523).
ALTER TABLE orb_relay_pending ADD COLUMN kind TEXT NOT NULL DEFAULT 'github_webhook';
