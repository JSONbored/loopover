-- #9271 (epic #9267): persistence for external decision-ledger anchoring attempts, success AND failure both.
--
-- migrations/0180_decision_ledger.sql named its own honest limit up front: a self-operated chain is
-- tamper-EVIDENT, not tamper-PROOF. Anchoring (#9270 for the signed payload; #9272/#9273 for the Rekor and
-- git-commit backends) closes that by publishing a periodic checkpoint somewhere the operator does not
-- control. But per the mechanism research on #9267: if anchoring can fail SILENTLY (best-effort, so a failure
-- must never block a review), an operator could make every attempt "fail" and quietly regress the ledger back
-- to tamper-evident-only with no visible signal. Recording every attempt -- success or failure -- as a public
-- row is what closes that: "anchoring has been failing for a week" becomes a fact anyone can observe, not
-- something only the operator's own logs show.
CREATE TABLE IF NOT EXISTS decision_ledger_anchors (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL,     -- the ledger seq this anchor commits to (decision_ledger.seq)
  row_hash      TEXT NOT NULL,        -- the anchored decision_ledger.row_hash at seq
  payload_json  TEXT NOT NULL,        -- canonical-JSON'd LedgerAnchorPayload (#9270) -- the exact signed bytes
  signature     TEXT NOT NULL,        -- base64 ECDSA signature over payload_json (#9270)
  key_id        TEXT NOT NULL,        -- which published anchor-signing key signed this attempt
  -- 'ots' (OpenTimestamps) is a named, tracked-but-not-yet-built backend per #9267's research -- included in
  -- the CHECK now so a future implementation issue does not need its own migration just to widen this list.
  backend       TEXT NOT NULL CHECK (backend IN ('rekor', 'git', 'ots')),
  -- Backend-specific resolvable reference, JSON. For Rekor: {shardBaseUrl, logIndex, logIdKeyId, uuid} --
  -- deliberately the FULL reference, not a bare logIndex, since Rekor's annual shard rotation makes a bare
  -- index unresolvable later. For git: {repo, sha}. NULL on a failed attempt (there is no reference yet).
  backend_ref   TEXT,
  -- R2 key for the full stored proof (Rekor's TransparencyLogEntry -- inclusion proof + signed checkpoint --
  -- needed for fully OFFLINE verification later, without trusting Rekor's continued availability). NULL on
  -- a failed attempt, and NULL for backends with no separate proof blob to store.
  proof_r2_key  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  error         TEXT,                 -- populated on status='failed', NULL on 'ok'
  created_at    TEXT NOT NULL
);
-- The public listing (`GET /v1/public/decision-ledger/anchors`) paginates newest-first per backend and
-- overall; this index serves both without a table scan as the table grows.
CREATE INDEX IF NOT EXISTS decision_ledger_anchors_created_at ON decision_ledger_anchors (created_at DESC);
CREATE INDEX IF NOT EXISTS decision_ledger_anchors_backend_created_at ON decision_ledger_anchors (backend, created_at DESC);
