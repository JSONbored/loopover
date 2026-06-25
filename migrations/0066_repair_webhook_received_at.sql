-- One-off repair: webhook_events.received_at rows holding the literal string produced by an old bug.
--
-- ROOT CAUSE (already fixed in code): an earlier Drizzle schema used a STATIC default for received_at. Drizzle
-- applies static defaults client-side, so an insert that omitted the column wrote the literal default STRING
-- rather than reaching the database time function. The schema now uses a $defaultFn (real ISO via nowIso), so no
-- NEW rows are corrupted. This migration repairs the ~20,472 historical rows.
--
-- Impact of leaving them: the literal sorts lexicographically after real ISO timestamps, so every time-range
-- query on received_at is wrong (it once produced a false "20,835 webhooks in 9 minutes" reading).
--
-- Repair strategy:
--   1. ~20,408 rows have a clean processed_at (a real ISO timestamp, verified never corrupted); received_at is
--      always <= processed_at, so processed_at is the best available estimate.
--   2. The remaining ~64 rows are queued webhooks that never processed (processed_at NULL); their receipt time is
--      unrecoverable, so stamp an epoch sentinel (received_at is NOT NULL). They sort as oldest, which is correct.
--
-- The corrupted value is matched as the concatenation ('CURRENT_' || 'TIMESTAMP') — NOT a single literal token —
-- so the self-host Postgres dialect shim (which rewrites that bare keyword) cannot mangle this WHERE clause. Both
-- SQLite and Postgres evaluate the concatenation to the same string at runtime.
UPDATE webhook_events
   SET received_at = processed_at
 WHERE received_at = ('CURRENT_' || 'TIMESTAMP')
   AND processed_at IS NOT NULL
   AND processed_at != ('CURRENT_' || 'TIMESTAMP');

UPDATE webhook_events
   SET received_at = '1970-01-01T00:00:00.000Z'
 WHERE received_at = ('CURRENT_' || 'TIMESTAMP');
