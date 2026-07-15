-- Latest deterministic copycat/plagiarism containment assessment (#1969), persisted separately from the
-- GitHub sync so a later maintenance pass (which re-reads the stored PR row rather than re-running the
-- containment engine) can act on it -- mirrors slop_risk/slop_band (see the pull_requests table's own comment).
ALTER TABLE pull_requests ADD COLUMN copycat_score INTEGER;
ALTER TABLE pull_requests ADD COLUMN copycat_matched_pull_number INTEGER;
