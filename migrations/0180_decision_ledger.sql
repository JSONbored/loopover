-- #8837 (epic #8828, Phase 4): hash-chained append-only decision ledger.
--
-- decision_records (0179) makes each verdict legible; this chain makes the SEQUENCE tamper-evident: nobody
-- can silently delete, reorder, or rewrite history without breaking the chain at a verifiable point. Each
-- row commits to its predecessor: row_hash = SHA-256(prev_hash || canonical-JSON of the semantic fields).
-- Every persistDecisionRecord write appends (including latest-finalize-wins rewrites of the same record id
-- -- supersessions are deliberately VISIBLE history, not silent replacement).
--
-- HONEST LIMIT (module header repeats this): a self-operated chain is tamper-EVIDENT, not tamper-PROOF --
-- the operator can still rewrite wholesale. External anchoring (signed checkpoints / witness cosigning) is
-- the tracked follow-up once tenants exist, per the epic's sequencing. That gap does not reduce the value
-- against every OTHER actor, or against accidental corruption.
CREATE TABLE IF NOT EXISTS decision_ledger (
  seq           INTEGER PRIMARY KEY,  -- explicit, contiguous (verified); NOT autoincrement -- gaps are breaks
  record_id     TEXT NOT NULL,        -- decision_records.id at append time
  record_digest TEXT NOT NULL,        -- the record's content digest (commits to the full record)
  prev_hash     TEXT NOT NULL,        -- row_hash of seq-1; 64 zeros at genesis
  row_hash      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
