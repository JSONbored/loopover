-- #preconv-parity (convergence prep): the shadow-parity AUDIT-SOURCE table.
--
-- This is the recording side of the pre-cutover parity harness (src/review/parity.ts). Before any per-repo
-- cutover from reviewbot to the gittensory-native review, we must PROVE the gittensory-native gate decision
-- matches reviewbot's on the SAME PR at the SAME COMMIT. computeGateParity / computeGateEval read this table.
--
-- gittensory has no `review_audit` table of its own (the ported parity.ts reads reviewbot's schema — see the
-- LIVE-USE PREREQUISITE note in parity.ts). This migration introduces exactly the columns those pure functions
-- read, with the two LATER-migration columns parity.ts called out — `source` (which writer made the decision)
-- and `head_sha` (which commit it was made on) — present from the start so the self-join works:
--
--   computeGateParity self-joins on (project, target_id, head_sha) per `source`, requires head_sha NON-NULL,
--   reads `decision` (merge/close/hold), `summary` (the reasonCode), and scopes by created_at >= a window.
--   computeGateEval folds (target_id, project, decision, event_type, created_at) per source.
--
-- WHO WRITES IT (this PR): the gittensory-native review path records ONE row per finalized gate decision with
-- source='gittensory-native' when REVIEWBOT_PARITY_AUDIT is ON (SHADOW mode — record only, no behavior change).
-- The AUTHORITATIVE side (source='reviewbot') is written by reviewbot during the deploy-time dual-run shadow
-- step; this migration just provides the shared store both writers append to and the harness reads.
--
-- Privacy: project (repo full name) + target_id (`repo#pr`) + head_sha + decision + reasonCode + timestamp
-- ONLY. No actor logins, no PR content, no trust/reward internals.
CREATE TABLE IF NOT EXISTS review_audit (
  id TEXT PRIMARY KEY NOT NULL,
  -- Which repo the decision is for (parity/eval group by + scope on this).
  project TEXT NOT NULL,
  -- The reviewed target, `repo#pr` (the self-join + outcome-join key).
  target_id TEXT NOT NULL,
  -- The audit event. The parity/eval reads filter event_type='gate_decision'; pr_outcome is reserved for the
  -- realized human merge/close ground truth (eval's answer key). Default to the gate-decision event so a bare
  -- insert is the common case.
  event_type TEXT NOT NULL DEFAULT 'gate_decision',
  -- The gate action: 'merge' | 'close' | 'hold' (computeGateParity only pairs these). Nullable because the
  -- read filters `decision IS NOT NULL`; a non-action row is simply never paired.
  decision TEXT,
  -- WHICH writer made this decision. 'gittensory-native' = the shadow writer this PR records; 'reviewbot' =
  -- the authoritative writer added during the deploy-time dual-run. The parity self-join is per-source.
  source TEXT NOT NULL DEFAULT 'gittensory-native',
  -- The commit the decision was made on. computeGateParity REQUIRES this non-null and joins on it so
  -- reviewbot@shaA is never compared to gittensory@shaB. Nullable in the schema (a decision with no head_sha
  -- is recorded but excluded from pairing), matching parity's `head_sha IS NOT NULL` filter.
  head_sha TEXT,
  -- The reasonCode for this decision (computeGateParity reads it as `summary` for the per-reasonCode breakdown).
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The parity/eval self-joins group by (source, event_type, project, target_id, head_sha) and scope on
-- created_at — index the hot path so the cutover-readiness read stays cheap.
CREATE INDEX IF NOT EXISTS review_audit_parity_idx
  ON review_audit(source, event_type, project, target_id, head_sha);
CREATE INDEX IF NOT EXISTS review_audit_window_idx
  ON review_audit(event_type, created_at);
