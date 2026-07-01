-- Orb fleet export watermark tie-break: when multiple resolved PRs share the same event_at, a
-- timestamp-only cursor skips the remainder after a partial batch. Persist the last exported
-- target_id alongside last_exported_at so pagination can resume within a tied timestamp group.
ALTER TABLE orb_export_cursor ADD COLUMN last_exported_target_id TEXT NOT NULL DEFAULT '';
