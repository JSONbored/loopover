-- Viewport x theme completeness matrix for the screenshot-table gate (#4535, #4540). Empty (default) JSON
-- arrays keep the original presence-only check byte-identical for every repo that hasn't opted in; a
-- non-empty screenshot_table_gate_require_viewports_json switches the evaluator into matrix mode, requiring a
-- labeled before/after row per configured viewport (x theme, when the themes column is also set). Mirrors the
-- existing when_labels_json / when_paths_json JSON-array-column shape from #2006 (migration 0117).
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_require_viewports_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repository_settings ADD COLUMN screenshot_table_gate_require_themes_json TEXT NOT NULL DEFAULT '[]';
