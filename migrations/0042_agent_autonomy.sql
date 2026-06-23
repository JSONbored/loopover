-- Agent-layer autonomy dial (#773, Wave 2 Phase 0). Per-action-class autonomy level stored as a JSON map
-- (action class -> observe|suggest|propose|auto_with_approval|auto). Default '{}' = deny-by-default: every
-- action class resolves to `observe` (gittensory watches but never acts) until a maintainer opts in. The
-- single source the action layer (#778) reads via resolveAutonomy. Additive; existing repos are unaffected.
ALTER TABLE repository_settings ADD COLUMN autonomy_json TEXT NOT NULL DEFAULT '{}';
