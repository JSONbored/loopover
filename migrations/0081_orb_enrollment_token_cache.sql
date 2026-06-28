-- Cache the brokered GitHub installation token on the enrollment row so POST /v1/orb/token mints from GitHub at
-- most once per install per ~hour instead of on EVERY call. Minting on every call throttles GitHub's
-- installation-token endpoint (observed 16-20s responses), which exceeds the engine's broker timeout and surfaces
-- as orb_broker_unavailable / orb_broker_degraded_serving_cached_token. The value is a JSON blob holding the
-- AES-256-GCM ciphertext/iv/salt (encrypted with TOKEN_ENCRYPTION_SECRET, same scheme as the relay secret) plus the
-- token's expiry; it is NULL until the first mint and re-minted once under the safety margin.
ALTER TABLE orb_enrollments ADD COLUMN cached_token_json TEXT;
