-- #8830 (epic #8828, Phase 2 — labels): human-adjudicated ground truth for the gate's decisions.
--
-- The reversal-based confirmation signal is a LOWER BOUND on error, not a label: humans reverse only what
-- they notice, so a silently-wrong merge scores as correct and every downstream accuracy figure inherits the
-- bias. This table holds the weekly stratified audit sample and its human adjudications — the calibration
-- set the risk-control thresholds (#8835) and the audited-accuracy estimate both read. One row per PR ever
-- (the UNIQUE on target_id): a PR re-drawn in a later week is skipped, never double-labeled.
CREATE TABLE IF NOT EXISTS decision_audit_labels (
  id              TEXT PRIMARY KEY,                    -- audit:<target_id>
  project         TEXT NOT NULL,                       -- owner/repo
  target_id       TEXT NOT NULL,                       -- owner/repo#N
  verdict         TEXT NOT NULL CHECK (verdict IN ('merge', 'close')),   -- the gate's decision at sample time
  -- Nullable: a holdout_close row (#8831) is created while the PR is still HELD -- there is no realized
  -- outcome yet; the human adjudication IS its ground truth. The weekly sampler always supplies one.
  outcome         TEXT CHECK (outcome IN ('merged', 'closed')),
  -- holdout_close (#8831): rows sourced by the randomized close-holdout rather than the weekly draw.
  stratum         TEXT NOT NULL CHECK (stratum IN ('merge_arm', 'close_arm', 'first_time_author', 'holdout_close')),
  rubric_version  TEXT NOT NULL,                       -- adjudications are only comparable within a version
  sampled_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'adjudicated')),
  adjudication    TEXT CHECK (adjudication IN ('correct', 'incorrect', 'uncertain')),
  reason_category TEXT,                                -- free-form-bounded category from the rubric
  adjudicated_at  TEXT,
  UNIQUE (target_id)
);
CREATE INDEX IF NOT EXISTS decision_audit_labels_status ON decision_audit_labels (status, sampled_at);
