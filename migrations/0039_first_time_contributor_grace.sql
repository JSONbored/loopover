-- First-time-contributor-aware gating (#552). Opt-in boolean: when on, a would-be hard BLOCK is softened to
-- a neutral/advisory gate for a genuine newcomer (0 merged PRs in this repo) who is NOT a repeat offender
-- (< 3 closed-unmerged PRs). Repeat offenders and authors with merge history are gated normally. Default 0
-- (off) preserves existing behavior for every current repo.
ALTER TABLE repository_settings ADD COLUMN first_time_contributor_grace INTEGER NOT NULL DEFAULT 0;
