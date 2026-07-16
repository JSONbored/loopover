import { homedir } from "node:os";
import { join } from "node:path";
import { openLocalStoreDb } from "./local-store.js";
import { applySchemaMigrations } from "./schema-version.js";

// Local SQLite persistence for the stateless MCP plan DAG (#2318). `loopover_build_plan`/`plan_status`/
// `record_step_result` are stateless — the caller holds the plan and passes it back each call — so a miner running
// unattended across process restarts needs somewhere to persist the plan object between calls. This is local-only
// bookkeeping (no plan logic, no network), 100% client-side, mirroring the package's other local stores. Every
// plan is validated against the `planDagSchema` shape (src/mcp/server.ts) on BOTH save and load, so a corrupted
// local row fails loudly instead of feeding a malformed plan back into `loopover_plan_status`.

const PLAN_STEP_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "skipped"]);
/** Derived plan-level status used for `listPlans({ status })`. */
export const PLAN_STATUSES = Object.freeze(["pending", "running", "completed", "failed"]);

const stepStatusSet = new Set(PLAN_STEP_STATUSES);
const planStatusSet = new Set(PLAN_STATUSES);
const defaultDbFileName = "plan-store.sqlite3";
let defaultPlanStore = null;

export function resolvePlanStoreDbPath(env = process.env) {
  const explicitPath = typeof env.LOOPOVER_MINER_PLAN_STORE_DB === "string"
    ? env.LOOPOVER_MINER_PLAN_STORE_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.LOOPOVER_MINER_CONFIG_DIR === "string"
    ? env.LOOPOVER_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "loopover-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const raw = dbPath ?? resolvePlanStoreDbPath();
  if (typeof raw !== "string" || !raw.trim()) throw new Error("invalid_plan_store_db_path");
  return raw.trim();
}

function normalizePlanId(planId) {
  if (typeof planId !== "string" || !planId.trim()) throw new Error("invalid_plan_id");
  return planId.trim();
}

function normalizePlanStatusFilter(status) {
  if (status === undefined || status === null) return undefined;
  if (!planStatusSet.has(status)) throw new Error("invalid_status");
  return status;
}

function isBoundedString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isBoundedInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

const STEP_KEYS = new Set(["id", "title", "actionClass", "dependsOn", "status", "attempts", "maxAttempts", "lastError"]);

function isValidStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) return false;
  for (const key of Object.keys(step)) if (!STEP_KEYS.has(key)) return false; // strict: no unknown keys
  if (!isBoundedString(step.id, 1, 100) || !isBoundedString(step.title, 1, 300)) return false;
  if (step.actionClass !== undefined && !isBoundedString(step.actionClass, 1, 60)) return false;
  if (!Array.isArray(step.dependsOn) || step.dependsOn.length > 50) return false;
  if (!step.dependsOn.every((dep) => isBoundedString(dep, 1, 100))) return false;
  if (!stepStatusSet.has(step.status)) return false;
  if (!isBoundedInt(step.attempts, 0, Number.MAX_SAFE_INTEGER)) return false;
  if (!isBoundedInt(step.maxAttempts, 1, 10)) return false;
  if (step.lastError !== undefined && step.lastError !== null && !isBoundedString(step.lastError, 0, 2000)) return false;
  return true;
}

/** Validate a plan against the `planDagSchema` shape (strict `{ steps: PlanStep[] }`, ≤100 steps). Throws on any
 *  malformed field so a bad plan can neither be saved nor read back. */
function validatePlanDag(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("invalid_plan");
  const keys = Object.keys(plan);
  if (keys.length !== 1 || keys[0] !== "steps") throw new Error("invalid_plan");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 100) {
    throw new Error("invalid_plan");
  }
  if (!plan.steps.every(isValidStep)) throw new Error("invalid_plan");
  const seenStepIds = new Set();
  for (const step of plan.steps) {
    if (seenStepIds.has(step.id)) throw new Error("invalid_plan");
    seenStepIds.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id || !seenStepIds.has(dep)) throw new Error("invalid_plan");
    }
  }
  const color = new Map();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const hasCycle = (id) => {
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const depColor = color.get(dep) ?? 0;
      if (depColor === 1) return true;
      if (depColor === 0 && byId.has(dep) && hasCycle(dep)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const step of plan.steps) {
    if ((color.get(step.id) ?? 0) === 0 && hasCycle(step.id)) {
      throw new Error("invalid_plan");
    }
  }
  return plan;
}

/** Derive a plan-level status from its steps: any failed → failed; else any running → running; else all steps
 *  finished (completed/skipped) with at least one step → completed; otherwise pending. */
function computePlanStatus(plan) {
  const steps = plan.steps;
  if (steps.some((step) => step.status === "failed")) return "failed";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.length > 0 && steps.every((step) => step.status === "completed" || step.status === "skipped")) {
    return "completed";
  }
  return "pending";
}

function rowToRecord(row) {
  let plan;
  try {
    plan = validatePlanDag(JSON.parse(row.plan_json));
  } catch {
    throw new Error("corrupted_plan_row"); // stored blob no longer matches the plan shape
  }
  // Also fail closed on the status column: a manually-edited or legacy row (predating the CHECK constraint) could
  // hold a status outside PLAN_STATUSES, which would otherwise violate the exported PlanRecord contract on read.
  if (!planStatusSet.has(row.status)) throw new Error("corrupted_plan_row");
  return { planId: row.plan_id, plan, status: row.status, updatedAt: row.updated_at };
}

// v1 -> v2 (#4939/#6597): additive tenant-scoping column, a prerequisite for any hosted, multi-tenant use of
// this same store's logic. NULL for every row today -- self-host behavior is byte-identical, since nothing
// reads or writes it yet. Same defensive column-presence guard as this file's sibling stores' own additive
// migrations (e.g. event-ledger.js's addTenantIdColumn).
function addTenantIdColumn(db) {
  const hasTenantIdColumn = db
    .prepare("PRAGMA table_info(miner_plans)")
    .all()
    .some((column) => column.name === "tenant_id");
  if (!hasTenantIdColumn) db.exec("ALTER TABLE miner_plans ADD COLUMN tenant_id TEXT");
}

/**
 * Opens the local plan store, creating the table on first use. `savePlan` is a single atomic INSERT…ON CONFLICT
 * upsert keyed by `plan_id`; the plan JSON is validated on save AND re-validated on load, so a corrupted row is
 * rejected rather than silently returned. (#2318)
 */
export function openPlanStore(dbPath = resolvePlanStoreDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  // openLocalStoreDb centralizes the mkdir(0o700)/chmod(0o600)/busy_timeout + crash-safe cleanup registration and
  // treats ':memory:' as a no-file special case, so this store no longer hand-rolls that boilerplate (#4826).
  const db = openLocalStoreDb(resolvedPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS miner_plans (
      plan_id TEXT PRIMARY KEY,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      updated_at TEXT NOT NULL
    )
  `);
  // Schema-version convention (#4832): stamp the baseline and run any post-baseline migrations.
  applySchemaMigrations(db, [addTenantIdColumn]);

  const saveStatement = db.prepare(`
    INSERT INTO miner_plans (plan_id, plan_json, status, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET
      plan_json = excluded.plan_json,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  const getStatement = db.prepare("SELECT * FROM miner_plans WHERE plan_id = ?");
  const listAllStatement = db.prepare("SELECT * FROM miner_plans ORDER BY plan_id ASC");
  const listStatusStatement = db.prepare("SELECT * FROM miner_plans WHERE status = ? ORDER BY plan_id ASC");

  return {
    dbPath: resolvedPath,
    savePlan(planId, plan) {
      const id = normalizePlanId(planId);
      validatePlanDag(plan);
      const status = computePlanStatus(plan);
      const updatedAt = new Date().toISOString();
      saveStatement.run(id, JSON.stringify(plan), status, updatedAt);
      return { planId: id, plan, status, updatedAt };
    },
    loadPlan(planId) {
      const row = getStatement.get(normalizePlanId(planId));
      return row ? rowToRecord(row) : null;
    },
    listPlans(filter = {}) {
      const status = normalizePlanStatusFilter(filter.status);
      if (status !== undefined) {
        return listStatusStatement.all(status).map(rowToRecord);
      }
      return listAllStatement.all().map(rowToRecord);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultPlanStore() {
  defaultPlanStore ??= openPlanStore();
  return defaultPlanStore;
}

export function savePlan(planId, plan) {
  return getDefaultPlanStore().savePlan(planId, plan);
}

export function loadPlan(planId) {
  return getDefaultPlanStore().loadPlan(planId);
}

export function listPlans(filter) {
  return getDefaultPlanStore().listPlans(filter);
}

export function closeDefaultPlanStore() {
  if (!defaultPlanStore) return;
  defaultPlanStore.close();
  defaultPlanStore = null;
}
