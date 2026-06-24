-- Convergence (#self-improve, #kill-switch) — the D1-backed operational-flag store the accuracy
-- circuit-breaker (GAP-4) reads/writes. A tiny key/value table the operator OR the autonomous self-tune
-- loop can flip INSTANTLY (no deploy). Byte-faithful to the reviewbot canonical table (its 0012_system_flags),
-- and exactly the columns the ported FlagStore binds (src/review/outcomes-wire.ts):
--   • isHoldOnly  — SELECT key, value FROM system_flags
--   • flagSetAt   — SELECT updated_at FROM system_flags WHERE key = ?
--   • setFlag     — INSERT OR REPLACE ... / DELETE WHERE key = ?
--
-- Flag families (one table, scoped key `<family>:<scope>` where <scope> is `global` or a repo full name):
--   holdonly:<scope>  — accuracy circuit-breaker: keep reviewing, but DOWNGRADE every would-MERGE to a human
--                       HOLD. Set by the auto-tuner when a repo's merge precision drops below the floor over a
--                       real sample (applyAutoTune), so the system stops repeating a bad call on its own; an
--                       auto-engaged breaker auto-clears after a cooldown once precision recovers
--                       (maybeAutoClearHoldOnly), and a human can clear it at any time.
--
-- FAIL-SAFE: both reads fail OPEN (last-known / null) so a DB blip never silently changes behavior, and with
-- no rows present isHoldOnly is false → the merge path is byte-identical until a breaker actually engages.
--
-- Flip manually, e.g.:
--   INSERT OR REPLACE INTO system_flags VALUES ('holdonly:owner/repo','1',CURRENT_TIMESTAMP);
--   DELETE FROM system_flags WHERE key='holdonly:owner/repo';
CREATE TABLE IF NOT EXISTS system_flags (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
