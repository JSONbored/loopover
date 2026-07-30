-- #9939: who applied the manual-review label, so the bot can lift what the bot applied.
--
-- The label is OVERLOADED: it is both the planner's own "held for a human" disposition and a maintainer's
-- manual safety freeze. agent-actions.ts therefore refuses to auto-remove it while it clears every sibling
-- disposition label, because it has no way to tell the two apart -- and auto-removing a human's deliberate
-- freeze would be far worse than leaving a stale one. That caution is correct and stays.
--
-- The cost of having no provenance is a one-way latch. Observed on #9935: applied when a finding fired
-- against a stale head, then never lifted after a rebase removed the cause and a fresh escalated review
-- returned zero findings. The PR was mergeable, green and clean, and still refused to merge until a human
-- removed the label by hand -- in the mode that is meant to have no human in it.
--
-- Recording the head SHA the PLANNER applied it at (and the reason it applied it FOR) makes the distinction
-- decidable: bot-applied labels become liftable once that specific reason clears, while a label with no
-- provenance row -- a human's, or one applied before this column existed -- keeps exactly today's behaviour
-- and is never touched automatically. Nullable with no backfill for precisely that reason: absence means
-- "not ours to lift", which is the safe reading for every pre-existing label.
ALTER TABLE pull_requests ADD COLUMN manual_review_label_applied_sha TEXT;
ALTER TABLE pull_requests ADD COLUMN manual_review_label_applied_reason TEXT;
