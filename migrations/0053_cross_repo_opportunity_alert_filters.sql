-- Cross-repo opportunity discovery (#1060): extend issue-watch subscriptions so the existing opt-in
-- notification channel can filter proactive opportunity alerts by repo lane and freshness window.
--
-- `lanes_json` stores the allowed repo lanes ([] = any lane). `freshness_days` stores the maximum issue
-- age in days to notify on (NULL = any age). Both fields are additive + nullable/defaulted so existing
-- subscriptions keep their current semantics.
ALTER TABLE issue_watch_subscriptions ADD COLUMN lanes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE issue_watch_subscriptions ADD COLUMN freshness_days INTEGER;
