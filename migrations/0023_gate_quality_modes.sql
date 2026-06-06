ALTER TABLE repository_settings ADD COLUMN linked_issue_gate_mode TEXT NOT NULL DEFAULT 'advisory';
ALTER TABLE repository_settings ADD COLUMN duplicate_pr_gate_mode TEXT NOT NULL DEFAULT 'advisory';
ALTER TABLE repository_settings ADD COLUMN quality_gate_mode TEXT NOT NULL DEFAULT 'advisory';
ALTER TABLE repository_settings ADD COLUMN quality_gate_min_score INTEGER;
