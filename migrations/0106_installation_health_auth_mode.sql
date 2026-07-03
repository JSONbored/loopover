-- Installation health needs to distinguish a brokered self-host (no local GitHub App private key by design,
-- permission introspection unavailable through the token broker today) from local App-key mode, so a brokered
-- deployment stops reporting a misleading "GitHub App credentials are not configured" / fabricated missing
-- permissions status (#selfhost-runtime-drift). Defaults to 'local' so every existing row (all cloud + local-mode
-- self-host installs, which is everything recorded before this migration) keeps its current, already-correct
-- meaning without a backfill.
ALTER TABLE installation_health ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'local';
