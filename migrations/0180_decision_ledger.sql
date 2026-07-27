-- #8837 (epic #8828, Phase 4): hash-chained append-only decision ledger.
--
-- decision_records (0179) makes each verdict legible; this chain makes the SEQUENCE tamper-evident: nobody
-- can silently delete, reorder, or rewrite history without breaking the chain at a verifiable point. Each
-- row commits to its predecessor: row_hash = SHA-256(prev_hash || canonical-JSON of the semantic fields).
-- Every persistDecisionRecord write appends (including latest-finalize-wins rewrites of the same record id
-- -- supersessions are deliberately VISIBLE history, not silent replacement).
--
-- HONEST LIMIT (module header repeats this; see migrations/0195_decision_ledger_anchors.sql, #9267): a
-- self-operated chain is tamper-EVIDENT against every actor except the operator, on its own. As of #9267, a
-- scheduled job (src/review/ledger-anchor-scheduler.ts) additionally publishes a SIGNED, self-describing
-- checkpoint of this chain's tip -- hourly, or every 256 new rows, whichever comes first -- to two places the
-- operator does not control: a Sigstore Rekor transparency log and a git commit (cross-mirrored by GH Archive
-- / Software Heritage the moment it's pushed). Rewriting history before the oldest still-referenced anchor
-- now requires forging that signature or fabricating matching evidence at an external mirror too, not just
-- editing this table. What remains open: the UNANCHORED TAIL since the last checkpoint is exactly as
-- tamper-evident-only as before anchoring existed -- anchoring bounds how far back an undetected rewrite
-- could reach, it does not make every row individually external-checkable in real time.
CREATE TABLE IF NOT EXISTS decision_ledger (
  seq           INTEGER PRIMARY KEY,  -- explicit, contiguous (verified); NOT autoincrement -- gaps are breaks
  record_id     TEXT NOT NULL,        -- decision_records.id at append time
  record_digest TEXT NOT NULL,        -- the record's content digest (commits to the full record)
  prev_hash     TEXT NOT NULL,        -- row_hash of seq-1; 64 zeros at genesis
  row_hash      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
