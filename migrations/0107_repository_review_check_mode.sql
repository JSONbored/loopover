-- Configurable review-check publish surface (#2852): `gateCheckMode` was a binary off/enabled switch for the
-- "Gittensory Orb Review Agent" check-run, with no way to publish it non-required (visibility only) or to go
-- fully dark without leaving a GitHub branch-protection required-status-check permanently unsatisfied. Defaults
-- to 'disabled' (matches gate_check_mode's own 'off' default for never-configured repos -- opt-in, unchanged).
-- Existing rows backfill from their CURRENT gate_check_mode so already-configured repos keep today's behavior
-- exactly: 'enabled' -> 'required' (still publishes, still fine to require in branch protection); 'off' (or any
-- other/legacy value) keeps the column default 'disabled' (still never publishes). gate_check_mode itself is
-- left untouched -- read by settings-preview.ts/the dashboard for back-compat display; the runtime publish
-- decision reads review_check_mode.
ALTER TABLE repository_settings ADD COLUMN review_check_mode TEXT NOT NULL DEFAULT 'disabled';
UPDATE repository_settings SET review_check_mode = 'required' WHERE gate_check_mode = 'enabled';
