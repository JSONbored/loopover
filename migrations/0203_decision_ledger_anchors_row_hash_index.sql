-- #9489: anchorBackendsMissingForRowHash queries
-- `SELECT DISTINCT backend FROM decision_ledger_anchors WHERE row_hash = ? AND status = 'ok' AND backend IN (...)`
-- once per row being re-anchored; without an index on (row_hash, status) that is a full table scan per call.
-- Lead with row_hash (the equality predicate) and include status so the `status = 'ok'` filter is served from
-- the index rather than a row fetch. Sibling precedent: decision_ledger_record_id in migrations/0198.
CREATE INDEX IF NOT EXISTS decision_ledger_anchors_row_hash_status ON decision_ledger_anchors (row_hash, status);
