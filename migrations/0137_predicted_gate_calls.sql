-- #predicted-live-gate-agreement (maintainer review-stack x AMS integration audit, 2026-07-09): the data
-- substrate for measuring how often the MCP `gittensory_predict_gate`/`gittensory_explain_gate_disposition`
-- verdict agrees with the REAL gate decision the same contributor's PR later receives.
--
-- WHY A NEW TABLE, NOT A `review_audit` ROW: `predictGateShape` has no PR-number field (it is an explicit
-- pre-PR-existence dry run), so a predicted call cannot be keyed `project#pr` the way recordNativeGateDecision
-- keys a real gate_decision -- there is no PR yet to key against. The only reliable correlation key available
-- at predict-time is (project, login, timestamp), which means CORRELATING a predicted call to its eventual
-- real PR requires a login-keyed join. `review_audit` (migrations/0049) is DELIBERATELY actor-login-free
-- ("No actor logins... ONLY") specifically because it feeds the anonymized cross-instance orb-collector export
-- (src/selfhost/orb-collector.ts) -- exactly the same reason migrations/0126 (contributor_gate_history) is its
-- own separate, local-only table rather than a review_audit column. This table follows that identical
-- precedent: a SEPARATE, LOCAL-ONLY, login-keyed substrate, never wired into exportOrbBatch or any other
-- cross-instance/public export path. See src/review/predicted-gate-calls.ts for the writer and
-- src/review/predicted-gate-agreement.ts for the reader, which joins this table against the ALREADY-EXISTING
-- contributor_gate_history (0126) -- the login-keyed real-decision data that table already records -- rather
-- than duplicating the real side of the comparison into a second copy.
--
-- Privacy: this table is per-login by design (see migrations/0126's identical rationale for why login, not a
-- hash, is fine for a LOCAL-ONLY table). Any output DERIVED from it (the agreement-rate metric) must remain
-- aggregated -- never render which login contributed which paired row on any public/contributor-facing surface.
CREATE TABLE IF NOT EXISTS predicted_gate_calls (
  id TEXT PRIMARY KEY NOT NULL,
  -- The GitHub login the prediction was requested for (the miner's own `login` input to predict_gate).
  login TEXT NOT NULL,
  -- Which repo the prediction is for.
  project TEXT NOT NULL,
  -- The predicted gate action: 'merge' | 'hold' (nativeGateActionFromConclusion's mapping -- the predicted-gate
  -- engine never predicts 'close', mirroring the live gate: it is a CHECK that passes or blocks, never closes).
  predicted_action TEXT NOT NULL,
  -- The raw predicted verdict conclusion (success/failure/action_required/neutral), kept alongside the
  -- collapsed predicted_action for observability -- e.g. distinguishing a hard blocker from an inconclusive hold.
  conclusion TEXT NOT NULL,
  -- Bounded reason-class code for the predicted verdict (mirrors review_audit.summary / neutralHoldReasonCode),
  -- never a raw finding title/detail (which can embed contributor- or per-repo-controlled text).
  reason_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The read side (computePredictedGateAgreement) scans "this project's predicted calls in a recency window,
-- grouped by login" to pair each against contributor_gate_history's real decisions.
CREATE INDEX IF NOT EXISTS predicted_gate_calls_project_login_idx
  ON predicted_gate_calls(project, login, created_at);
