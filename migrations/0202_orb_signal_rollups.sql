-- #9783: orb_signals grows without bound. Every self-host instance exports into it hourly, and it is a
-- PUBLIC data source -- computeFleetAnalytics reads it for the /fairness headline, and #9775's weekly fleet
-- trend reads it again.
--
-- It could not simply be added to RETENTION_POLICY. Two live surfaces depend on history the raw rows carry:
-- fleet-admin.ts's listFleetInstances reports a LIFETIME signalCount per instance, and
-- /v1/internal/fleet/analytics accepts an arbitrary ?days= window. A plain prune would silently turn the
-- first into "signals in the retention window" with no change of label, and make the second report a window
-- it no longer has data for -- the same window/denominator mismatch #9676 and #9793 have been correcting.
--
-- So this is the #9474 pattern (orb_pr_outcomes -> orb_outcome_rollups), which exists for exactly this
-- shape: fold the aging rows into a durable aggregate in the SAME transaction that deletes them, so the
-- information survives even though the per-PR rows do not.
--
-- GRANULARITY IS DAILY, and deliberately keeps the whole confusion matrix rather than a bare count. The
-- fleet numbers are not a single total: computeFleetAnalytics folds (verdict, outcome, reversal_flag,
-- gate_reasoncode_bucket) cells through foldInstance to get decisionAccuracy, and #9775's trend buckets the
-- same cells by day. Rolling up to a scalar would preserve signalCount and destroy every accuracy figure
-- beyond the window; rolling up these cells per day preserves BOTH -- a historical week reconstructs to the
-- same numbers it would have shown while the raw rows existed.
--
-- What is genuinely dropped is per-PR identity: repo_hash/pr_hash. Those are per-instance HMACs that cannot
-- be reversed or joined across instances, so individually they carry no long-term analytical value; their
-- only role is the (instance_id, repo_hash, pr_hash) dedup key, which matters while a row can still be
-- re-exported and not after it has aged out.
CREATE TABLE IF NOT EXISTS orb_signal_rollups (
  instance_id            TEXT    NOT NULL,
  -- UTC day (YYYY-MM-DD) of the folded rows' decision_timestamp, falling back to received_at -- the same
  -- COALESCE the weekly trend buckets on, so a folded day lands in the week it would have landed in live.
  day                    TEXT    NOT NULL,
  -- NOT NULL with an empty-string sentinel, unlike orb_signals where both of these are nullable. A PRIMARY
  -- KEY over nullable columns does not work here: SQLite does not enforce NOT NULL on PRIMARY KEY columns of
  -- a rowid table, and every NULL compares DISTINCT, so two folds of the same day would silently insert
  -- duplicate cells instead of accumulating into one. The fold COALESCEs to '' on the way in.
  --
  -- '' is safe for both readers, which is why a sentinel is preferable to dropping the columns: foldInstance
  -- only ever tests `verdict === "merge"` / `=== "close"` and `gate_reasoncode_bucket === "policy_action"`,
  -- and '' fails those exactly as NULL did -- an unset verdict counted as a hold before and still does.
  gate_verdict           TEXT    NOT NULL DEFAULT '',
  outcome                TEXT    NOT NULL,
  reversal_flag          TEXT    NOT NULL,
  gate_reasoncode_bucket TEXT    NOT NULL DEFAULT '',
  n                      INTEGER NOT NULL,
  updated_at             TEXT    NOT NULL,
  -- One row per cell per instance per day. The prune folds with an upsert that ADDS to `n`, so a day folded
  -- across two prune runs (rows arriving late, or a slice boundary splitting a day) accumulates rather than
  -- overwriting.
  PRIMARY KEY (instance_id, day, gate_verdict, outcome, reversal_flag, gate_reasoncode_bucket)
);

-- The read path: every consumer scans a day range across all instances, then joins to orb_instances to keep
-- unregistered ones out of published numbers.
CREATE INDEX IF NOT EXISTS orb_signal_rollups_day ON orb_signal_rollups (day, instance_id);

-- The prune scans orb_signals by received_at (both the slice-boundary SELECT and the DELETE predicate), so
-- it needs an index leading with that column or every hourly retention run degrades to a full table scan +
-- sort. 0193 and 0196 (#9472/#9473) did this for every policy table of their era, and the retention suite
-- now enforces it for all of them -- this is simply that same index for the entry added here.
CREATE INDEX IF NOT EXISTS idx_orb_signals_received_at ON orb_signals (received_at);
