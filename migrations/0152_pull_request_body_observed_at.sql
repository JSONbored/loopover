-- First time LoopOver observed a GENUINE (possibly empty) `body` for this PR, as opposed to a narrower webhook
-- event whose embedded pull_request sub-object omits `body` entirely (#linked-issue-sparse-first-upsert). NULL
-- means no real body has ever been synced yet -- downstream linked-issue hard-rule enforcement must treat that
-- as "unverified", never as "confirmed no linked issue", so a sparse FIRST-EVER webhook can no longer trip a
-- false-positive auto-close. Set once, never cleared (mirrors linked_issue_hard_rule_violated_at).
ALTER TABLE pull_requests ADD COLUMN body_observed_at TEXT;
