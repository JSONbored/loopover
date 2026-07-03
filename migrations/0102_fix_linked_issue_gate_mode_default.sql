-- #selfhost-linked-issue-gate-drift: repository_settings.linked_issue_gate_mode was persisted as 'block'
-- by migration 0023 (its initial ADD COLUMN default) and migration 0025 (a since-superseded "restore"
-- backfill that flipped any 'advisory' row to 'block' for repos with gate_check_mode='enabled'), even
-- though missing a linked issue is only ever supposed to be advisory unless a maintainer explicitly opts
-- into blocking. The application-level fallback (src/db/repositories.ts) and every documented default
-- (.gittensory.yml.example, docs.tuning.tsx, the settings API schema) already say 'advisory' -- only the
-- persisted column value drifted.
--
-- #gate-review-2727 round 1: require_linked_issue = 0 alone does NOT prove drift. linkedIssueGateMode and
-- requireLinkedIssue are independently settable (the maintainer settings UI exposes them as a separate
-- dropdown and toggle; both PUT .../settings and the internal settings route accept linkedIssueGateMode on
-- its own), so a maintainer can genuinely choose 'block' while leaving requireLinkedIssue off. No column on
-- this row records which field a maintainer last touched, so per-field intent can't be recovered by itself.
--
-- What CAN be proven, path 1: updated_at is bumped on every write through upsertRepositorySettings
-- (src/db/repositories.ts) -- the only code path that ever changes this row after INSERT -- while
-- created_at is set once, at INSERT, and never touched again. updated_at = created_at therefore means this
-- row has never been written to since it was first created: no settings save, by anyone, has ever happened
-- for this repo. Its 'block' value can only be the byproduct of migration 0023's column default or 0025's
-- blanket flip -- provable drift, not inference from an unrelated field.
--
-- #gate-review-2727 round 2: path 1 alone is too narrow -- a row last written to BEFORE migration 0023 ran
-- (updated_at > created_at, but that write predates 0023) has updated_at != created_at and was skipped, even
-- though that write could not possibly have set linked_issue_gate_mode: the column did not exist yet. That
-- is an equally provable drift signal, just anchored to a different fixed point.
--
-- What CAN be proven, path 2: migration 0023 was deployed at commit 66e4dd6b (2026-06-05T14:01:39-06:00 =
-- 2026-06-05T20:01:39Z; this repo auto-deploys `wrangler d1 migrations apply --remote` on every merge to
-- main, so the merge commit time is a same-day, conservatively-early proxy for the real remote apply time --
-- true apply is always slightly AFTER this timestamp, never before, so using it as an inclusive upper bound
-- can only under-select rows, never wrongly include a row genuinely written after the column existed). A row
-- whose updated_at is at or before that instant was last written before linked_issue_gate_mode existed at
-- all, so its current value is provably the column-add default (or 0025's later blanket flip), not a choice.
--
-- A row with updated_at > created_at AND updated_at after that cutoff has been through at least one real
-- settings write since the column existed and is left alone, even though some of those may also be
-- untouched drift this migration can no longer safely reach -- a maintainer stuck with a leftover 'block'
-- default can flip it from the settings UI. Leaving that row alone is the safe failure mode; silently
-- downgrading a real 'block' opt-in to advisory is not.
UPDATE repository_settings
SET linked_issue_gate_mode = 'advisory'
WHERE linked_issue_gate_mode = 'block'
  AND require_linked_issue = 0
  AND (updated_at = created_at OR updated_at <= '2026-06-05T20:01:39.000Z');
