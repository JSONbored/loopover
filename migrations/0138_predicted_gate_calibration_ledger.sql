-- #predicted-gate-calibration-ledger (maintainer review-stack x AMS integration audit, 2026-07-09): a
-- login-keyed, SERVER-SIDE-ONLY ledger pairing a contributor's self-reported MCP predict_gate verdict
-- against the eventual REAL gate decision their PR received -- the review stack's own tamper-resistant
-- calibration ground truth, per issue #4517.
--
-- WHY THIS IS SEPARATE FROM #4516's predicted_gate_calls / computePredictedGateAgreement: that pair answers
-- an AGGREGATE, project-level question ("how often does prediction agree with reality") computed FRESH on
-- every read, with no per-login row ever persisted or exposed. This table answers a DIFFERENT question --
-- persisting ONE durable row per (login, real decision) pairing, becoming the substrate a FUTURE trust-tiering
-- or personalized-calibration consumer (#2349) can read. THE CRITICAL PROPERTY: nothing here is ever
-- writable, or even readable, by the contributor/miner whose row it is -- see
-- src/review/predicted-gate-calibration-ledger.ts's module header for the full anti-farming rationale (a
-- miner-writable version of this exact data would itself be a farming vector, per #2350).
--
-- Privacy/precedent: login-keyed and LOCAL-ONLY, mirroring contributor_gate_history's (migrations/0126)
-- identical rationale for why login (not a hash) is fine here specifically because it never leaves the
-- instance -- never wired into exportOrbBatch or any other cross-instance/public export path.
CREATE TABLE IF NOT EXISTS predicted_gate_calibration_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  -- The GitHub login both the prediction and the real decision belong to.
  login TEXT NOT NULL,
  -- Which repo this pairing is for.
  project TEXT NOT NULL,
  -- The REAL decision's target, `repo#pr`.
  target_id TEXT NOT NULL,
  -- The self-reported predicted action at predict-time: 'merge' | 'hold'.
  predicted_action TEXT NOT NULL,
  -- The REAL gate action this login's PR actually received: 'merge' | 'hold'.
  real_decision TEXT NOT NULL,
  -- 1 when predicted_action = real_decision, 0 otherwise -- denormalized so a future reader never needs to
  -- re-derive agreement (and can never be tricked by a re-derivation bug into miscounting it).
  agreed INTEGER NOT NULL,
  -- When the paired predict_gate call was made, and when the real decision landed -- both kept (not just
  -- created_at) so a future reader can measure predict-to-decision latency, not just the outcome.
  predicted_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- INSERT-ONLY by design (see the writer's own doc comment): no UPDATE statement anywhere touches this table,
-- so a webhook replay or re-review appends another consistent row rather than ever overwriting history.
CREATE INDEX IF NOT EXISTS predicted_gate_calibration_ledger_login_idx
  ON predicted_gate_calibration_ledger(login, created_at);
CREATE INDEX IF NOT EXISTS predicted_gate_calibration_ledger_project_idx
  ON predicted_gate_calibration_ledger(project, created_at);
