-- Convergence (#self-improve, #273–#279): the D1 tables the ported self-improvement "apply" surface
-- (src/review/auto-apply.ts) reads/writes — a per-project store of runtime tunable overrides the loop raises
-- (confidenceFloor / scopeCap), the SHADOW soak queue a tightening recommendation waits in before promotion,
-- and the override-lifecycle audit. STRICTLY a SAFETY surface: the loop only ever writes a STRICTLY-TIGHTENING
-- override after a soak window, never a loosening one (isStrictlyTightening + evaluateShadowPromotion enforce
-- the direction), and every write is recorded to override_audit. Additive + idempotent: these tables are only
-- ever read/written when the REVIEWBOT_SELFTUNE flag is ON.
--
-- Schema is byte-faithful to the ported module's INSERT/SELECT (src/review/auto-apply.ts):
--   • tunables_overrides        — loadOverride / writeLiveOverride / deleteLiveOverride
--   • tunables_overrides_shadow — loadShadowOverride / writeShadowOverride / deleteShadowOverride
--   • override_audit            — recordOverrideAudit / listOverrideAudit
-- (mirrors the reviewbot canonical tables; the columns + names match the bound queries exactly.)
--
-- NOTE (config-application DEFERRED): gittensory's gate has NO confidenceFloor / scopeCap tunable and its
-- native outcome signal measures gate FALSE POSITIVES (a loosening direction), so a promoted override here is
-- NOT YET read by the live gate-config resolution — see src/review/selftune-wire.ts. These tables back the
-- shadow-soak + audit + recommendation recording; reading a promoted override into the live gate is a noted
-- follow-up that must not risk loosening the gate.

-- The active LIVE override per project (one row per project; the apply path MERGES partial writes).
CREATE TABLE IF NOT EXISTS tunables_overrides (
  project TEXT PRIMARY KEY NOT NULL,
  confidence_floor REAL,
  scope_cap_files INTEGER,
  scope_cap_lines INTEGER,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clear_at TEXT
);

-- The SHADOW soak queue: a recommended tightening waits here (with a future validated_until soak deadline)
-- until the cron promotes it to live once it passes the gate (tightening + evidence + soaked).
CREATE TABLE IF NOT EXISTS tunables_overrides_shadow (
  project TEXT PRIMARY KEY NOT NULL,
  confidence_floor REAL,
  scope_cap_files INTEGER,
  scope_cap_lines INTEGER,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  validated_until TEXT,
  clear_at TEXT
);

-- The override-lifecycle audit (target-free): one row per shadow/apply/promote event, newest read first.
CREATE TABLE IF NOT EXISTS override_audit (
  id TEXT PRIMARY KEY NOT NULL,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS override_audit_project_created_idx
  ON override_audit(project, created_at);
