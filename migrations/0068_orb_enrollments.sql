-- Gittensory Orb central GitHub App (#1255) — the token-broker enrollment ledger. A maintainer authorizes the
-- Orb App (OAuth) and is bound, server-side, to a SPECIFIC installation they administer; their self-hosted
-- container is then issued a one-time enrollment secret (stored HASHED, never plaintext) which it exchanges for
-- short-lived installation tokens. installation_id is written here at the OAuth callback after an authority
-- check — the container can never name a different installation at token-exchange time. registered=1 on the
-- referenced install is still required to mint (the das-github-mirror trust gate). The whole broker is gated by
-- ORB_BROKER_ENABLED (default off) so this table is inert until enabled.
CREATE TABLE IF NOT EXISTS orb_enrollments (
  enroll_id            TEXT PRIMARY KEY NOT NULL,                 -- opaque id, returned to the container
  installation_id      INTEGER,                                  -- bound at the OAuth callback; NULL while pending
  maintainer_login     TEXT,
  maintainer_github_id INTEGER,
  secret_hash          TEXT,                                     -- SHA-256 of the one-time secret; NULL until enrolled
  state                TEXT NOT NULL DEFAULT 'pending',          -- pending | authorized | enrolled | revoked
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  authorized_at        TEXT,
  enrolled_at          TEXT,
  last_token_at        TEXT,
  revoked_at           TEXT
);
-- A given secret hashes to exactly one enrollment (NULLs are distinct in SQLite, so many pending rows are fine).
CREATE UNIQUE INDEX IF NOT EXISTS orb_enrollments_secret_hash_idx ON orb_enrollments(secret_hash);
CREATE INDEX IF NOT EXISTS orb_enrollments_installation_idx ON orb_enrollments(installation_id);
