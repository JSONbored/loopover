-- #9131: submitter_stats.submissions counted webhook PASSES, not submissions -- recordSubmissionOutcome had
-- no per-PR idempotency key, so re-gating the SAME PR (a body edit, a push, or a third party's review
-- comment on a rival's held PR) incremented the counter again every time. This log is the idempotency key:
-- one row per (project, submitter, pull_number, outcome) ever actually counted. recordSubmissionOutcome
-- INSERT OR IGNOREs here first and only bumps submitter_stats when the insert actually created a new row --
-- so N re-gates of one PR yield exactly one recorded outcome, and a still-open "manual" hold is recorded (at
-- most) once per PR rather than once per re-gate. recorded_at also gives the burst-detection signal a real
-- WINDOW to decay against, instead of reading the all-time submitter_stats aggregate forever.
CREATE TABLE IF NOT EXISTS submitter_outcome_log (
  project TEXT NOT NULL,
  submitter TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project, submitter, pull_number, outcome)
);

CREATE INDEX IF NOT EXISTS submitter_outcome_log_window_idx ON submitter_outcome_log(project, submitter, recorded_at);
