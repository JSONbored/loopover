import { describe, expect, it } from "vitest";

import {
  buildLoopConsumptionEntry,
  totalConsumptionForTenant,
  type LoopConsumptionEntry,
  type LoopRunFacts,
} from "../../packages/loopover-engine/src/loop-consumption";
import { evaluateTenantQuota } from "../../packages/loopover-engine/src/tenant-quota";

const facts = (over: Partial<LoopRunFacts> = {}): LoopRunFacts => ({
  tenantId: "acme",
  loopId: "loop-1",
  startedAtMs: 1_000,
  endedAtMs: 61_000,
  outcome: "completed",
  computeUnitsMetered: 42,
  ...over,
});

const entry = (over: Partial<LoopConsumptionEntry> = {}): LoopConsumptionEntry => ({
  tenantId: "acme",
  loopId: "loop-1",
  outcome: "completed",
  wallClockMs: 60_000,
  computeUnits: 42,
  complete: true,
  ...over,
});

describe("buildLoopConsumptionEntry (#4792)", () => {
  // Acceptance criterion 1: a completed loop produces an entry with accurate elapsed compute/time.
  it("a completed run bills its real elapsed wall-clock and metered compute", () => {
    expect(buildLoopConsumptionEntry(facts())).toEqual({
      tenantId: "acme",
      loopId: "loop-1",
      outcome: "completed",
      wallClockMs: 60_000,
      computeUnits: 42,
      complete: true,
    });
  });

  // Acceptance criterion 2: a killed-mid-run loop ALSO produces an accurate, consistent entry.
  it("a killed run bills identically for what it consumed, flagged incomplete rather than dropped", () => {
    const killed = buildLoopConsumptionEntry(facts({ outcome: "killed", endedAtMs: 31_000, computeUnitsMetered: 20 }));
    expect(killed).toEqual({
      tenantId: "acme",
      loopId: "loop-1",
      outcome: "killed",
      wallClockMs: 30_000,
      computeUnits: 20,
      complete: false,
    });
    // Same shape as a completed run — a killed run is billed, never silently zeroed or discarded.
    expect(Object.keys(killed).sort()).toEqual(Object.keys(buildLoopConsumptionEntry(facts())).sort());
  });

  it("carries tenant/loop identity through unchanged, so an entry stays traceable to its run", () => {
    const out = buildLoopConsumptionEntry(facts({ tenantId: "globex", loopId: "loop-9" }));
    expect(out.tenantId).toBe("globex");
    expect(out.loopId).toBe("loop-9");
  });

  describe("never emits a nonsensical charge", () => {
    it("an end before its start (clock skew, stale start on a kill) floors at 0, never a negative charge", () => {
      expect(buildLoopConsumptionEntry(facts({ startedAtMs: 61_000, endedAtMs: 1_000 })).wallClockMs).toBe(0);
    });

    it("non-finite timestamps and compute normalize to 0 rather than NaN", () => {
      const out = buildLoopConsumptionEntry(
        facts({ startedAtMs: Number.NaN, endedAtMs: Number.POSITIVE_INFINITY, computeUnitsMetered: Number.NaN }),
      );
      expect(out.wallClockMs).toBe(0);
      expect(out.computeUnits).toBe(0);
    });

    it("negative and fractional metered compute normalize to a non-negative integer", () => {
      expect(buildLoopConsumptionEntry(facts({ computeUnitsMetered: -5 })).computeUnits).toBe(0);
      expect(buildLoopConsumptionEntry(facts({ computeUnitsMetered: 7.9 })).computeUnits).toBe(7);
    });

    it("negative timestamps normalize before subtracting, so elapsed stays sane", () => {
      expect(buildLoopConsumptionEntry(facts({ startedAtMs: -1_000, endedAtMs: 5_000 })).wallClockMs).toBe(5_000);
    });

    it("an unmetered run bills 0 compute — never inferred from elapsed time", () => {
      const out = buildLoopConsumptionEntry(facts({ computeUnitsMetered: 0 }));
      expect(out.computeUnits).toBe(0);
      expect(out.wallClockMs).toBe(60_000); // time still real; compute is not guessed from it
    });
  });
});

describe("totalConsumptionForTenant (#4792)", () => {
  it("sums a tenant's entries into evaluateTenantQuota's TenantUsage shape", () => {
    const usage = totalConsumptionForTenant([entry(), entry({ loopId: "loop-2", wallClockMs: 10_000, computeUnits: 8 })], "acme");
    expect(usage).toEqual({ computeUnitsUsed: 50, wallClockMsUsed: 70_000 });
  });

  it("INVARIANT: never bills a tenant for another tenant's compute", () => {
    const usage = totalConsumptionForTenant(
      [entry(), entry({ tenantId: "globex", loopId: "loop-3", wallClockMs: 999_000, computeUnits: 999 })],
      "acme",
    );
    expect(usage).toEqual({ computeUnitsUsed: 42, wallClockMsUsed: 60_000 });
  });

  it("an empty period, and a tenant with no entries, total to zero rather than undefined", () => {
    expect(totalConsumptionForTenant([], "acme")).toEqual({ computeUnitsUsed: 0, wallClockMsUsed: 0 });
    expect(totalConsumptionForTenant([entry()], "nobody")).toEqual({ computeUnitsUsed: 0, wallClockMsUsed: 0 });
  });

  it("normalizes a corrupt stored entry instead of propagating NaN into the total", () => {
    const usage = totalConsumptionForTenant([entry({ computeUnits: Number.NaN, wallClockMs: -5 })], "acme");
    expect(usage).toEqual({ computeUnitsUsed: 0, wallClockMsUsed: 0 });
  });

  it("counts a killed run's consumption toward the period like any other", () => {
    expect(totalConsumptionForTenant([entry({ outcome: "killed", complete: false })], "acme")).toEqual({
      computeUnitsUsed: 42,
      wallClockMsUsed: 60_000,
    });
  });

  // The reason this primitive exists: its output is exactly what the sibling quota evaluator reads, so a
  // period's real consumption can be reconciled against the tenant's allocation (#4792 ↔ #4796).
  it("composes with evaluateTenantQuota: summed consumption drives the allocation decision", () => {
    const entries = [entry({ computeUnits: 90, wallClockMs: 30_000 })];
    const usage = totalConsumptionForTenant(entries, "acme");
    const quota = { computeUnits: 100, wallClockMs: 60_000, maxConcurrentLoops: 2 };

    expect(evaluateTenantQuota({ ...usage, activeLoops: 0 }, quota)).toMatchObject({ allowed: true, exceeded: null });

    const overspent = totalConsumptionForTenant([...entries, entry({ loopId: "loop-2", computeUnits: 10, wallClockMs: 0 })], "acme");
    expect(evaluateTenantQuota({ ...overspent, activeLoops: 0 }, quota)).toMatchObject({ allowed: false, exceeded: "compute" });
  });
});
