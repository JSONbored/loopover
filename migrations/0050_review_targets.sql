-- #preconv-state (convergence prep): the review-target state machine + DECISION CACHE.
--
-- This is the single missing stateful table in the reviewbot → gittensory state migration (#1025). gittensory
-- already provisioned submitter_stats (0046), tunables_overrides/_shadow + override_audit (0047), and
-- review_audit (0049) — but had no review_targets, even though already-ported code reads it:
--   - src/review/ops.ts (computeAgentHealth: SELECT ... FROM review_targets; reversal join
--     `review_audit a JOIN review_targets t ON t.id = a.target_id`)
--   - src/review/submitter-reputation.ts (the live, quality-weighted reputation signal is derived FROM review_targets)
-- Those paths are dead until this table exists.
--
-- WHY IT MATTERS — the two load-bearing concepts both live here as COLUMNS (not separate tables):
--   1. Per-head_sha DECISION CACHE: `decided_sha` + `decision_json` — the terminal gate verdict is computed
--      ONCE per commit; a webhook for the same head_sha replays the cached decision instead of re-running the
--      non-deterministic dual-AI. Seeding this BEFORE a repo goes live is what prevents the re-review STORM
--      (flipped merge/close verdicts + duplicate approvals/notifications on every formerly-terminal PR).
--   2. APPROVE-ONCE-PER-COMMIT: `approved_sha` — the commit already approved, so merge retries don't stack
--      duplicate "Approved" reviews; a new commit re-approves exactly once.
--
-- Schema = reviewbot's full accumulated review_targets (its 0001 + 0003/0005/0006/0007/0010 ALTERs folded into
-- one CREATE). Natural key (project, kind, repo, number) == the PK id `${project}:${kind}:${repo}#${number}`.
-- Kept raw-SQL-only (matching the 0046–0049 parity-store convention); deliberately NOT added to the Drizzle
-- schema, and the reviewbot FK review_audit.target_id → review_targets(id) is OMITTED (gittensory's review_audit
-- already dropped it, so the two tables stay decoupled and bulk copy needs no ordering FK).
--
-- Privacy: internal review state only — no PR content, no trust/reward internals beyond the gate verdict.
CREATE TABLE IF NOT EXISTS review_targets (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT,
  head_sha TEXT,
  head_ref TEXT,
  base_ref TEXT,
  head_repo TEXT,
  base_repo TEXT,
  installation_id INTEGER,
  submitter TEXT,
  author_association TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT,
  verdict_summary TEXT,
  last_delivery_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  last_error TEXT,
  terminal_at TEXT,
  changed_files TEXT,
  decided_sha TEXT,
  decision_json TEXT,
  approved_sha TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project, kind, repo, number)
);

-- Mirror reviewbot's hot-path indexes (sweep-by-due, retention prune, reputation/health reads).
CREATE INDEX IF NOT EXISTS idx_review_targets_project_status_due ON review_targets (project, status, next_review_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_review_targets_created_at ON review_targets (created_at);
CREATE INDEX IF NOT EXISTS idx_review_targets_terminal_at ON review_targets (terminal_at);
CREATE INDEX IF NOT EXISTS idx_review_targets_project_verdict ON review_targets (project, verdict);
