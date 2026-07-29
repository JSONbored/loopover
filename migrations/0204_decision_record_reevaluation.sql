-- Verdict immutability per head SHA (#9742).
--
-- decision_records (0179) already keeps every evaluation of a (repo, pull, head_sha) -- a repeat lands as
-- `<id>:revN` and #8837 gives each its own ledger chain row, so nothing is ever silently replaced. What the
-- record could not say is WHY a second evaluation of the same head SHA happened, or WHICH verdict it
-- supersedes. Without those, "this PR was evaluated once" and "this PR was evaluated three times and one
-- result was kept" are indistinguishable in the public record.
--
-- Both columns are NULLABLE and stay NULL for a first evaluation, which is the overwhelming majority of rows
-- and needs no reason: a new head SHA (force-push, new commits) legitimately starts a fresh verdict.
-- Populated ONLY on a re-evaluation of a head SHA already carrying a verdict, where the writer must supply
-- them -- enforced at the ledger-write layer so no caller can bypass it.
ALTER TABLE decision_records ADD COLUMN reevaluation_reason TEXT;
ALTER TABLE decision_records ADD COLUMN supersedes_record_id TEXT;

-- WHO caused the re-evaluation, when that is a person rather than a schedule: the operator behind a
-- manual re-gate, the maintainer who ran `@loopover review`. NULL for the machine-paced causes, which
-- is most of them -- an actor column that invented "system" for those would make the two
-- indistinguishable from a real named actor.
ALTER TABLE decision_records ADD COLUMN reevaluation_actor TEXT;

-- Answers "how many evaluations did this head SHA receive, and why" without scanning: the re-evaluation
-- rollups (#9743) read exactly this shape, per window and per repo.
CREATE INDEX IF NOT EXISTS decision_records_reevaluation
  ON decision_records (reevaluation_reason, created_at);
