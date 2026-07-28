-- Instance subscription-CLI credentials (#9543): the FLEET path for rotating CLAUDE_CODE_OAUTH_TOKEN (and
-- the codex credential) without a restart. A single self-hosted box can rotate its credential in place on
-- disk -- the secret file is a bind mount the running container re-reads at AI-call time -- but a
-- multi-instance deployment has no shared filesystem, so the value lives here instead and every instance
-- resolves it fresh per call (src/selfhost/provider-credential-registry.ts).
--
-- Keyed by PROVIDER, not by repo: unlike repository_ai_keys / repository_linear_keys (the per-maintainer
-- BYOK tables this deliberately mirrors), this is the instance's OWN subscription credential, so there is
-- exactly one row per provider. Encrypted at rest with the same AES-256-GCM envelope and the same
-- TOKEN_ENCRYPTION_SECRET (see src/utils/crypto.ts); `last4` is a display-only hint derived from the
-- plaintext at write time, and the plaintext is never stored, never logged, and never returned by the API.
--
-- No DB-side DEFAULT CURRENT_TIMESTAMP on created_at/updated_at, matching migrations/0111_linear_backend.sql:
-- every write goes through Drizzle's $defaultFn(() => nowIso()) (src/db/schema.ts), which always supplies the
-- ISO timestamp explicitly, so a SQLite-format fallback here would be unused surface area, not a safeguard.
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  salt TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  last4 TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
