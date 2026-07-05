import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPlanStore } from "../../packages/gittensory-miner/lib/plan-store.js";
import type { PlanDag, PlanRecord } from "../../packages/gittensory-miner/lib/plan-store.d.ts";
import {
  parsePlanListArgs,
  parsePlanShowArgs,
  renderPlanTable,
  runPlanCli,
  runPlanList,
  runPlanShow,
} from "../../packages/gittensory-miner/lib/plan-store-cli.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

const PLAN: PlanDag = {
  steps: [
    { id: "s1", title: "Build", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 3 },
    { id: "s2", title: "Test", dependsOn: ["s1"], status: "running", attempts: 0, maxAttempts: 3 },
  ],
};

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-plan-store-cli-"));
  roots.push(root);
  const store = openPlanStore(join(root, "plan-store.sqlite3"));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner plan store CLI (#2318)", () => {
  it("parsePlanListArgs and parsePlanShowArgs validate argv", () => {
    expect(parsePlanListArgs(["--status", "running", "--json"])).toEqual({
      json: true,
      status: "running",
    });
    expect(parsePlanShowArgs(["plan-a", "--json"])).toEqual({
      planId: "plan-a",
      json: true,
    });
    expect(parsePlanListArgs(["--status", "bogus"])).toEqual({
      error: expect.stringMatching(/Invalid status/),
    });
    expect(parsePlanShowArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner plan show"),
    });
  });

  it("renderPlanTable formats plan rows and empty output", () => {
    const plans: PlanRecord[] = [
      {
        planId: "alpha",
        status: "running",
        updatedAt: "2026-07-04T12:00:00.000Z",
        plan: PLAN,
      },
    ];
    expect(renderPlanTable([])).toBe("no saved plans");
    expect(renderPlanTable(plans)).toContain("alpha");
    expect(renderPlanTable(plans)).toContain("    2");
  });

  it("runPlanList prints table and JSON output with status filtering", () => {
    const planStore = tempStore();
    planStore.savePlan("running-plan", PLAN);
    planStore.savePlan("done-plan", {
      steps: [{ id: "a", title: "done", dependsOn: [], status: "completed", attempts: 1, maxAttempts: 1 }],
    });

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(
      runPlanList([], {
        openPlanStore: () => planStore,
      }),
    ).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("running-plan");

    log.mockClear();
    expect(
      runPlanList(["--status", "completed", "--json"], {
        openPlanStore: () => planStore,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      plans: [expect.objectContaining({ planId: "done-plan", status: "completed" })],
    });
  });

  it("runPlanShow prints summary and JSON output for a saved plan", () => {
    const planStore = tempStore();
    planStore.savePlan("plan-a", PLAN);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      runPlanShow(["plan-a"], {
        openPlanStore: () => planStore,
      }),
    ).toBe(0);
    expect(log).toHaveBeenCalledWith("running (2 steps)");

    log.mockClear();
    expect(
      runPlanShow(["plan-a", "--json"], {
        openPlanStore: () => planStore,
      }),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      plan: expect.objectContaining({ planId: "plan-a", status: "running" }),
    });
  });

  it("runPlanShow fails closed when the plan id is missing", () => {
    const planStore = tempStore();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(
      runPlanShow(["missing"], {
        openPlanStore: () => planStore,
      }),
    ).toBe(2);
    expect(error).toHaveBeenCalledWith("plan_not_found");
  });

  it("runPlanCli dispatches list and show subcommands", () => {
    const planStore = tempStore();
    planStore.savePlan("plan-b", PLAN);
    const options = { openPlanStore: () => planStore };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(runPlanCli("list", ["--json"], options)).toBe(0);
    expect(runPlanCli("show", ["plan-b"], options)).toBe(0);
    expect(log).toHaveBeenCalled();
  });

  it("rejects unknown plan subcommands and options", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runPlanCli("save", [])).toBe(2);
    expect(runPlanList(["--verbose"])).toBe(2);
    expect(String(error.mock.calls[0]?.[0])).toContain("Unknown plan subcommand");
  });
});
