-- Orb event RELAY (#1255): a brokered self-host registers its public relay URL so the central Orb can FORWARD its
-- repos' webhook events to the container (which reviews + acts via brokered tokens). The container's enrollment
-- secret is stored ENCRYPTED here (AES-256-GCM via TOKEN_ENCRYPTION_SECRET) so the Orb can HMAC-sign each forwarded
-- event with it; the container verifies the signature with its own ORB_ENROLLMENT_SECRET. Per-enrollment isolation
-- (a leak of one container's secret never lets it forge to another), and a DB-only leak can't forge (the encryption
-- key is a separate secret). The relay URL is SSRF-validated (https, public host) before it's ever forwarded to.
ALTER TABLE orb_enrollments ADD COLUMN relay_url TEXT;
ALTER TABLE orb_enrollments ADD COLUMN relay_secret_enc TEXT;
ALTER TABLE orb_enrollments ADD COLUMN relay_secret_iv TEXT;
ALTER TABLE orb_enrollments ADD COLUMN relay_secret_salt TEXT;
ALTER TABLE orb_enrollments ADD COLUMN relay_registered_at TEXT;
