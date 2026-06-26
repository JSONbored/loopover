-- Dual-app identity (#selfhost-app-id): record which GitHub App an installation belongs to, so a backend can
-- tell its OWN installations from a SECOND gittensory App installed on the same account (cloud + self-host
-- running side by side during the migration). Nullable: only `installation` events and the App-installation API
-- refresh carry app_id, so existing rows backfill lazily on their next event. The webhook entry fails OPEN — an
-- unknown app_id always processes — so this column is byte-identical until it is populated.
ALTER TABLE installations ADD COLUMN app_id INTEGER;
