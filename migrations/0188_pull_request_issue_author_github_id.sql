-- #9125: every contributor-scoped anti-abuse control (the blacklist, open-item caps, moderation tally,
-- review-nag ping counter) keyed on the mutable GitHub login -- the immutable numeric user id was captured
-- on other paths (auth/security.ts, orb/oauth.ts) but discarded at the webhook content-ingest boundary. A
-- banned contributor could clear every one of these controls at once by renaming their account. These
-- columns let the ingest upsert persist the id alongside the login so identity-keyed controls can match on
-- id-when-present, surviving a rename.
ALTER TABLE pull_requests ADD COLUMN author_github_id INTEGER;
ALTER TABLE issues ADD COLUMN author_github_id INTEGER;
