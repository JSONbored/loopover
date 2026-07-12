-- Keep the contributor-triggered calibration read indexed after login casing canonicalization (#2349).
-- SQLite/D1 cannot use the plain (login, created_at) index for WHERE lower(login) = ?, so this matching
-- expression index preserves case-insensitive lookup semantics without scanning the insert-only ledger.
CREATE INDEX IF NOT EXISTS predicted_gate_calibration_ledger_login_lower_idx
  ON predicted_gate_calibration_ledger(lower(login), created_at);
