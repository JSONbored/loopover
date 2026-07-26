-- #8836 (epic #8828, Phase 4 — trust surface): content-addressed decision records.
--
-- One row per (PR, head sha) holding the full canonical-JSON decision record and its SHA-256 content digest:
-- the resolved-config digest, the clause that fired, and (when an AI review contributed) the model/prompt
-- commitments. This is what lets a contributor argue "clause X of config abc123 closed me" — and what the
-- golden-corpus replay (#8832), the hash-chained ledger (#8837), and the replay harness (#8838) all consume.
-- Latest-finalize-wins per id, mirroring the gate_decision row the record explains.
--
-- NOTE: numbered 0179 — 0178 (decision_audit_labels) ships in the sibling PR for #8830 and must merge first.
CREATE TABLE IF NOT EXISTS decision_records (
  id             TEXT PRIMARY KEY,        -- record:<owner/repo>#<pr>@<head sha>
  repo_full_name TEXT NOT NULL,
  pull_number    INTEGER NOT NULL,
  head_sha       TEXT NOT NULL,
  action         TEXT NOT NULL,           -- merge | close | hold (the acted disposition, never the raw conclusion)
  reason_code    TEXT NOT NULL,           -- blocker class | policy_close:<kind> | gate conclusion
  record_digest  TEXT NOT NULL,           -- SHA-256 over the canonical record_json
  record_json    TEXT NOT NULL,           -- the full canonical-JSON DecisionRecord
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_records_target ON decision_records (repo_full_name, pull_number, created_at);
