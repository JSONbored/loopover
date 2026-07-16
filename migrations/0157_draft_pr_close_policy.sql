-- Draft-PR close policy (#draft-pr-close-policy): contributors were opening PRs directly as draft (or
-- converting to draft immediately after opening) to farm bot labels/AI-review/CI feedback without ever
-- being subject to a real one-shot disposition -- distinct from the existing reviewEvasionProtection family
-- (draft-dodge / self-close / draft-conversion / repeated-cycling), which only enforces AFTER a review has
-- already run against the PR's current head, or on the 2nd+ conversion. This policy enforces on ANY draft,
-- including the very first one, before a review pass has had a chance to run at all. Off by default (opt-in,
-- unlike reviewEvasionProtection's default-close) since immediately closing every draft PR is a much harsher
-- posture than reviewEvasionProtection's narrower abuse-pattern detection, and a maintainer should choose it
-- deliberately.
ALTER TABLE repository_settings ADD COLUMN draft_pr_close_policy TEXT NOT NULL DEFAULT 'off';
