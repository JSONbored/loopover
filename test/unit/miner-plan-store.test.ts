import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_STATUSES,
  closeDefaultPlanStore,
  openPlanStore,
  resolvePlanStoreDbPath,
} from "../../packages/gittensory-miner/lib/plan-store.js";
import type { PlanDag } from "../../packages/gittensory-miner/lib/plan-store.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-plan-store-"));
  roots.push(root);
  const store = openPlanStore(join(root, "nested", "plan-store.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPlanStore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PLAN: PlanDag = {
  steps: [
    { id: "s1", title: "Build the thing", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 3 },
    { id: "s2", title: "Test it", dependsOn: ["s1"], status: "running", attempts: 0, maxAttempts: 3, actionClass: "test" },
  ],
};

describe("gittensory-miner plan store (#2318)", () => {
  it("exposes the frozen plan-status vocabulary", () => {
    expect(PLAN_STATUSES).toEqual(["pending", "running", "completed", "failed"]);
    expect(Object.isFrozen(PLAN_STATUSES)).toBe(true);
  });

  it("resolves the DB path from env override, miner config dir, XDG config, then the home default", () => {
    expect(resolvePlanStoreDbPath({ GITTENSORY_MINER_PLAN_STORE_DB: "/custom/p.sqlite3" })).toBe("/custom/p.sqlite3");
    expect(resolvePlanStoreDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/custom/config" })).toBe(
      "/custom/config/plan-store.sqlite3",
    );
    expect(resolvePlanStoreDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/gittensory-miner/plan-store.sqlite3");
    expect(resolvePlanStoreDbPath({})).toMatch(/\/\.config\/gittensory-miner\/plan-store\.sqlite3$/);
  });

  it("creates the SQLite file with owner-only permissions and loads null before any save", () => {
    const store = tempStore();
    expect(statSync(store.dbPath).mode & 0o077).toBe(0);
    expect(store.loadPlan("missing")).toBeNull();
    expect(store.listPlans()).toEqual([]);
  });

  it("saves a plan and loads it back verbatim, deriving a plan-level status", () => {
    const store = tempStore();
    const saved = store.savePlan("p1", PLAN);
    expect(saved).toMatchObject({ planId: "p1", plan: PLAN, status: "running" }); // has a running step
    const loaded = store.loadPlan("p1");
    expect(loaded?.plan).toEqual(PLAN);
    expect(loaded?.status).toBe("running");
  });

  it("upserts on the same planId and lists plans filtered by derived status", () => {
    const store = tempStore();
    store.savePlan("running-plan", PLAN);
    store.savePlan("done-plan", {
      steps: [{ id: "a", title: "done", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 1 }],
    });
    // Re-save p1 as fully completed → status flips, no duplicate row.
    store.savePlan("running-plan", {
      steps: [{ id: "s1", title: "Build the thing", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 3 }],
    });
    expect(store.listPlans().map((r) => r.planId)).toEqual(["done-plan", "running-plan"]); // one row each
    expect(store.listPlans({ status: "completed" }).map((r) => r.planId)).toEqual(["done-plan", "running-plan"]);
    expect(store.listPlans({ status: "running" })).toEqual([]);
    expect(() => store.listPlans({ status: "bogus" as never })).toThrow("invalid_status");
  });

  it("rejects a malformed plan on save rather than persisting it", () => {
    const store = tempStore();
    expect(() => store.savePlan("x", { steps: [{ id: "s1", title: "no status", dependsOn: [], attempts: 0, maxAttempts: 1 } as never] })).toThrow("invalid_plan");
    expect(() => store.savePlan("x", { steps: "nope" as never })).toThrow("invalid_plan");
    expect(() => store.savePlan("x", { steps: [], extra: 1 } as never)).toThrow("invalid_plan"); // strict: no unknown keys
    expect(() => store.savePlan("", PLAN)).toThrow("invalid_plan_id");
  });

  it("rejects a corrupted row on load instead of returning a malformed plan", () => {
    const store = tempStore();
    store.savePlan("p1", PLAN);
    // Corrupt the stored blob via a raw connection, then read it back through the store.
    const raw = new DatabaseSync(store.dbPath);
    raw.prepare("UPDATE miner_plans SET plan_json = ? WHERE plan_id = ?").run('{"steps":[{"bad":true}]}', "p1");
    raw.close();
    expect(() => store.loadPlan("p1")).toThrow("corrupted_plan_row");
  });
});
