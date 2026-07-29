-- Findings raised per evaluation (#9743).
--
-- The per-author-class parity rollups publish "findings raised per PR" beside the block/close and hold
-- rates. Those numbers are a fairness claim, so they have to be reproducible by an outsider from the
-- anchored ledger alone -- and findings were only ever stored in `ai_review_cache.findings_json`, which is
-- keyed for REUSE rather than anchored and is pruned independently. Counting a published fairness figure
-- out of a cache would make it unverifiable and, worse, quietly wrong once the cache turned over.
--
-- NULLABLE, and null for every row written before this: a caller with no findings to report (a policy
-- close, an update_branch) is genuinely different from an evaluation that raised zero, and the rollups
-- treat the two differently rather than averaging a guess.
ALTER TABLE decision_records ADD COLUMN findings_count INTEGER;

-- Answers "findings per PR, per author class, per window" without scanning the whole table.
CREATE INDEX IF NOT EXISTS decision_records_findings
  ON decision_records (created_at, findings_count);
