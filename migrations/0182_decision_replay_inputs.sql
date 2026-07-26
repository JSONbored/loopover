-- #8838 (epic #8828, Phase 4 — trust surface): private replay inputs for decision records.
--
-- One row per decision record holding the EXACT inputs the deterministic gate pipeline consumed — the input
-- advisory findings, the resolved GateCheckPolicy, the policy-close kind, and the evaluation snapshot
-- (conclusion + ordered blocker codes) — so any decision can be re-derived bit-exactly by the replay
-- harness (scripts/replay-decision.ts). DELIBERATELY A SIBLING TABLE, not a decision_records column: the
-- public record's contract is digests-only for config (a contributor sees the COMMITMENT, never the
-- resolved private policy values), and the input findings carry contributor content. Replay inputs are
-- operator-private; the record's record_digest still publicly commits the decision they explain.
CREATE TABLE IF NOT EXISTS decision_replay_inputs (
  record_id   TEXT PRIMARY KEY,            -- decision_records.id (record:<owner/repo>#<pr>@<head sha>)
  replay_json TEXT NOT NULL,               -- {findings, policy, policyCloseKind, evaluated:{conclusion, blockerCodes}}
  created_at  TEXT NOT NULL
);
