-- Agent-layer safety controls (#776, Wave 2 Phase 0). Per-repo kill-switch + dry-run/shadow mode the action
-- layer (#778) consults via resolveAgentActionMode (alongside the GLOBAL env switch AGENT_ACTIONS_PAUSED).
-- `agent_paused` = take NO action on this repo; `agent_dry_run` = log what would happen without mutating.
-- Both default 0 (off) — additive, existing repos are unaffected.
ALTER TABLE repository_settings ADD COLUMN agent_paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repository_settings ADD COLUMN agent_dry_run INTEGER NOT NULL DEFAULT 0;
