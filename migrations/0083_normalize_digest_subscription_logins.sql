-- Normalize digest_subscriptions login/email to lowercase, deduplicating rows that collide under the unique
-- (login, email) index. No CREATE TEMP TABLE: Cloudflare D1's remote authorizer rejects temp objects with
-- "not authorized: SQLITE_AUTH". Delete losers BEFORE lowercasing survivors, or canonicalization trips the index.

-- Drop every row but the newest per case-insensitive (login, email) group (tie-break: updated_at, created_at, id).
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

-- Lowercase the survivors; post-dedup each has a distinct lowercased (login, email), so the unique index holds.
UPDATE digest_subscriptions
SET login = lower(login),
    email = lower(email);
