-- Auto-maintain policy (#774, Wave 2 Phase 0). Per-repo merge method + approval count for the agent action
-- layer, stored as JSON ({ requireApprovals, mergeMethod }). Default '{}' resolves to the conservative
-- defaults (squash / 1 approval) via normalizeAutoMaintainPolicy. Additive; existing repos are unaffected.
ALTER TABLE repository_settings ADD COLUMN auto_maintain_json TEXT NOT NULL DEFAULT '{}';
