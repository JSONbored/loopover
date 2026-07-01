-- Normalize digest_subscriptions login/email to lowercase, deduplicating rows that would collide under the
-- unique (login, email) index once normalized. Written WITHOUT a temp table: Cloudflare D1's SQL authorizer
-- rejects CREATE TEMP TABLE with "not authorized: SQLITE_AUTH [code: 7500]" (temp objects are unsupported on
-- the remote), so the original temp-table form applied fine on self-hosted SQLite but failed the remote
-- `wrangler d1 migrations apply`.

-- 1. Drop the losers: within each case-insensitive (login, email) group keep only the newest row and delete
--    the rest. The row_number() tie-break (updated_at, then created_at, then id — all DESC) matches the
--    original, so the surviving id per group is unchanged.
DELETE FROM digest_subscriptions
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY lower(login), lower(email)
        ORDER BY updated_at DESC, created_at DESC, id DESC
      ) AS rn
    FROM digest_subscriptions
  )
  WHERE rn > 1
);

-- 2. Canonicalize the survivors. Post-dedup every surviving row already has a distinct
--    (lower(login), lower(email)), so lowering login/email in place cannot violate the unique index.
UPDATE digest_subscriptions
SET login = lower(login),
    email = lower(email);
