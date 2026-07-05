-- Review-evasion protection (#review-evasion-protection): a contributor closing or converting their OWN PR
-- to draft while gittensory has an ACTIVE review pass running against it is dodging the one-shot review
-- process, not making an ordinary close. active_review_tracking durably records that a fresh review pass
-- started for a specific repo/PR/headSha BEFORE any cost-bearing AI-review work begins, so the closed/
-- converted_to_draft webhook handlers can tell evasion (a close during an active pass) apart from an
-- ordinary close after the review already concluded. One row per (repo, PR); status flips
-- active -> terminal once the pass concludes (published, PR closed/merged, head moved, or evasion
-- enforcement completed) so a later, unrelated close is never mistaken for evasion.
CREATE TABLE IF NOT EXISTS active_review_tracking (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  author_login TEXT,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS active_review_tracking_pr_unique ON active_review_tracking (repo_full_name, pull_number);

-- Per-repo review-evasion settings, layered the same way as every other anti-abuse mechanism in this file
-- (contributorCap/blacklist/reviewNag): reviewEvasionProtection is off by default (zero behavior change for
-- an install that hasn't opted in); reviewEvasionLabel is NOT NULL with a string default (mirrors
-- blacklist_label/review_nag_label -- the "no label" case is a `.gittensory.yml`-only override, never
-- persisted); reviewEvasionComment defaults to posting the explanation comment, matching the existing
-- draft-dodge/reopen-reclose guards' unconditional explanation comment.
ALTER TABLE repository_settings ADD COLUMN review_evasion_protection TEXT NOT NULL DEFAULT 'off';
ALTER TABLE repository_settings ADD COLUMN review_evasion_label TEXT NOT NULL DEFAULT 'review-evasion';
ALTER TABLE repository_settings ADD COLUMN review_evasion_comment INTEGER NOT NULL DEFAULT 1;
