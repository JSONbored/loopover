-- Per-record PBKDF2 salt for the v2 BYOK key-encryption envelope (defense-in-depth; decouples each
-- record's derived AES key). Nullable: existing v1 rows keep salt = NULL and decrypt with the legacy
-- constant salt. New writes store a random salt and set key_version = 2. See src/utils/crypto.ts.
ALTER TABLE repository_ai_keys ADD COLUMN salt TEXT;
