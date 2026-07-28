-- #9277 (epic #9267): widen decision_ledger_anchors' backend CHECK to admit 'bittensor' — the optional,
-- Gittensor/SN74-audience on-chain commitment backend. The submission itself runs on the operator's own node
-- infrastructure (never this Worker); this table records its reported attempts, success AND failure, exactly
-- like the Rekor/git rows (#9271's whole design: a backend that can fail silently is a backend an operator
-- can silently disable). SQLite cannot ALTER a CHECK constraint, so this is the standard rebuild-and-rename.
CREATE TABLE decision_ledger_anchors_new (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL,
  row_hash      TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  signature     TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  backend       TEXT NOT NULL CHECK (backend IN ('rekor', 'git', 'ots', 'bittensor')),
  -- For bittensor: {netuid, blockNumber, blockHash, hotkey} — deliberately the FULL historical-retrieval
  -- reference: CommitmentOf is overwritten in place on-chain, so a verifier needs the block, not chain state.
  backend_ref   TEXT,
  proof_r2_key  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  error         TEXT,
  created_at    TEXT NOT NULL
);
INSERT INTO decision_ledger_anchors_new SELECT * FROM decision_ledger_anchors;
DROP TABLE decision_ledger_anchors;
ALTER TABLE decision_ledger_anchors_new RENAME TO decision_ledger_anchors;
CREATE INDEX IF NOT EXISTS decision_ledger_anchors_created_at ON decision_ledger_anchors (created_at DESC);
CREATE INDEX IF NOT EXISTS decision_ledger_anchors_backend_created_at ON decision_ledger_anchors (backend, created_at DESC);
