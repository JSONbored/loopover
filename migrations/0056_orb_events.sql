-- Gittensory Orb (#1219): local outcome-signal store. Records the gate verdict and
-- final outcome (merged / closed) for every PR the engine reviewed. Used by the Orb
-- export job to batch-send calibration signals to the central collector (opt-in) or
-- to keep them local for operator-only analysis (ORB_AIR_GAP=true).
CREATE TABLE IF NOT EXISTS orb_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo        TEXT    NOT NULL,
  pr_number   INTEGER NOT NULL,
  head_sha    TEXT    NOT NULL,
  outcome     TEXT    NOT NULL CHECK (outcome IN ('merged', 'closed')),
  gate_verdict TEXT,                -- 'approve' | 'block' | 'comment' | NULL (no review recorded)
  time_to_close_ms INTEGER,        -- ms from PR open to close; NULL if opened_at unavailable
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  exported_at TEXT,                 -- NULL = pending export; set when batch-sent to collector
  UNIQUE (repo, pr_number, head_sha)  -- idempotent: same close event may arrive more than once
);
CREATE INDEX IF NOT EXISTS orb_events_repo_pr    ON orb_events (repo, pr_number);
CREATE INDEX IF NOT EXISTS orb_events_export_pending ON orb_events (exported_at) WHERE exported_at IS NULL;
