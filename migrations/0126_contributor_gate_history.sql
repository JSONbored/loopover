-- #personalized-calibration-ledger (PR 1 of #2349): the per-contributor gate-decision data substrate.
--
-- #2349 wants a personalized gate-prediction confidence adjustment per contributor/miner history. That needs
-- a per-actor accuracy query, but `review_audit` (migrations/0049) is DELIBERATELY actor-login-free for
-- privacy — its own migration comment states "No actor logins, no PR content, no trust/reward internals." That
-- constraint exists because `review_audit` feeds `exportOrbBatch` (src/selfhost/orb-collector.ts), an
-- anonymized cross-instance export pipeline; adding a login column there would leak actor identity into that
-- export path. This table is a SEPARATE, LOCAL-ONLY substrate — structurally a sibling of `review_audit` (one
-- row per finalized gate decision, written from the exact same call sites as `recordNativeGateDecision` in
-- src/review/parity-wire.ts), but keyed by login, and it must NEVER be wired into `exportOrbBatch` or any
-- other cross-instance/public export path.
--
-- Login (not an HMAC hash) is used deliberately: unlike `review_audit`'s cross-instance export concern, this
-- table never leaves the instance and is never rendered on any public surface (see the design-note comment at
-- the top of src/review/contributor-calibration.ts) — the same precedent `contributor_evidence` and
-- `contributor_scoring_profiles` (migrations/0004) already establish for per-login local-only data. Hashing
-- would only add a lookup-key translation step with no privacy benefit for this specific access pattern.
--
-- THIS PR ONLY POPULATES THE TABLE. Nothing reads it yet — the confidence-adjustment function that would
-- consume it (in packages/gittensory-engine/src/predicted-gate.ts) is explicit follow-up work, deliberately
-- deferred so the safety-critical "a personalization adjustment must never bypass a hard blocker" invariant
-- gets its own focused review.
CREATE TABLE IF NOT EXISTS contributor_gate_history (
  id TEXT PRIMARY KEY NOT NULL,
  -- The GitHub login this decision's PR was authored by. Public information (tied to a public PR) — not a
  -- secret the way a trust score or reward value is; the privacy concern this table's design addresses is
  -- never rendering an AGGREGATE per-login accuracy figure publicly, not the raw login itself.
  login TEXT NOT NULL,
  -- Mirrors review_audit.source: which writer made this decision. Always 'gittensory-native' today (the only
  -- writer of this table), carried as its own column for the same self-join-ready shape as review_audit
  -- rather than hardcoding an assumption that never changes into every reader.
  source TEXT NOT NULL DEFAULT 'gittensory-native',
  -- Which repo the decision is for.
  project TEXT NOT NULL,
  -- The reviewed target, `repo#pr`.
  target_id TEXT NOT NULL,
  -- The gate action: 'merge' | 'close' | 'hold' — mirrors review_audit.decision.
  decision TEXT NOT NULL,
  -- The commit the decision was made on.
  head_sha TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The future per-actor calibration read is "this login's decisions in a recent window" — index the hot path.
CREATE INDEX IF NOT EXISTS contributor_gate_history_login_idx
  ON contributor_gate_history(login, source, created_at);
