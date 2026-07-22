-- Loopover Orb token-broker (#8064) — a STORED (not minted) secret value, for a credential the caller already
-- has in hand and just needs custody of (e.g. a hosted tenant's Postgres connection string, #7180's
-- provisioning core) as opposed to the GitHub-token type's mint-on-exchange shape (#7174's secret_type
-- discriminator). Same encrypted-at-rest triplet + explicit version column as repositories.ts's BYOK
-- provider-key storage (repository_ai_keys) -- NOT broker.ts's own cached_token_json shape, which is a TTL'd
-- mint CACHE, a different thing entirely from a value that must persist indefinitely with no re-derivation
-- possible. NULL for every existing github_token row; that type never writes these columns.
ALTER TABLE orb_enrollments ADD COLUMN secret_value_ciphertext TEXT;
ALTER TABLE orb_enrollments ADD COLUMN secret_value_iv TEXT;
ALTER TABLE orb_enrollments ADD COLUMN secret_value_salt TEXT;
ALTER TABLE orb_enrollments ADD COLUMN secret_value_version INTEGER;
