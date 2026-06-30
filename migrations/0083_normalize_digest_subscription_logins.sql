CREATE TEMP TABLE digest_subscriptions_canonical AS
SELECT id, lower(login) AS login, lower(email) AS email, status, source, created_at, updated_at
FROM (
  SELECT
    id,
    login,
    email,
    status,
    source,
    created_at,
    updated_at,
    row_number() OVER (
      PARTITION BY lower(login), lower(email)
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM digest_subscriptions
)
WHERE rn = 1;

DELETE FROM digest_subscriptions;

INSERT INTO digest_subscriptions (id, login, email, status, source, created_at, updated_at)
SELECT id, login, email, status, source, created_at, updated_at
FROM digest_subscriptions_canonical;

DROP TABLE digest_subscriptions_canonical;
