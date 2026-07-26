import { describe, expect, it } from "vitest";

import {
  evaluateTenantQuota,
  evaluateTenantQuotaSoftWarnings,
} from "../../packages/loopover-engine/src/tenant-quota";

const QUOTA = { computeUnits: 100, wallClockMs: 60_000, maxConcurrentLoops: 3 };

describe("evaluateTenantQuota (#4796)", () => {
  it("allows a tenant within every dimension and reports headroom", () => {
    const d = evaluateTenantQuota({ computeUnitsUsed: 40, wallClockMsUsed: 10_000, activeLoops: 1 }, QUOTA);
    expect(d.allowed).toBe(true);
    expect(d.exceeded).toBeNull();
    expect(d.reason).toBeNull();
    expect(d.remaining).toEqual({ computeUnits: 60, wallClockMs: 50_000, concurrentLoops: 2 });
  });

  it("stops a tenant that has exhausted its compute allocation, with a user-facing reason (acceptance 1)", () => {
    const d = evaluateTenantQuota({ computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(d.allowed).toBe(false);
    expect(d.exceeded).toBe("compute");
    expect(d.reason).toContain("compute units");
    expect(d.reason).toContain("100");
    expect(d.remaining.computeUnits).toBe(0);
  });

  it("reports the time dimension when compute is fine but wall-clock is exhausted", () => {
    const d = evaluateTenantQuota({ computeUnitsUsed: 10, wallClockMsUsed: 60_000, activeLoops: 0 }, QUOTA);
    expect(d.exceeded).toBe("time");
    expect(d.reason).toContain("wall-clock");
    expect(d.remaining.wallClockMs).toBe(0);
  });

  it("reports the concurrency dimension when compute and time are fine but max loops are running", () => {
    const d = evaluateTenantQuota({ computeUnitsUsed: 10, wallClockMsUsed: 1_000, activeLoops: 3 }, QUOTA);
    expect(d.exceeded).toBe("concurrency");
    expect(d.reason).toContain("loops running");
    expect(d.remaining.concurrentLoops).toBe(0);
  });

  it("checks dimensions in a fixed precedence — compute is reported before time or concurrency", () => {
    const d = evaluateTenantQuota({ computeUnitsUsed: 200, wallClockMsUsed: 99_999, activeLoops: 9 }, QUOTA);
    expect(d.exceeded).toBe("compute");
  });

  it("normalizes non-finite and negative inputs to 0 so a decision is never NaN or negative", () => {
    const d = evaluateTenantQuota(
      { computeUnitsUsed: Number.NaN, wallClockMsUsed: -5, activeLoops: Infinity },
      { computeUnits: 100, wallClockMs: 60_000, maxConcurrentLoops: Number.NaN },
    );
    // NaN compute → 0 used (within), -5 time → 0 used (within), Infinity loops → 0 used, NaN loop cap → 0.
    // activeLoops(0) >= loopCap(0) → concurrency is the first exhausted dimension.
    expect(d.exceeded).toBe("concurrency");
    expect(d.remaining.computeUnits).toBe(100);
    expect(Number.isNaN(d.remaining.wallClockMs)).toBe(false);
    expect(d.remaining.wallClockMs).toBe(60_000);
  });

  it("denies a tenant with zero allocation immediately", () => {
    const d = evaluateTenantQuota(
      { computeUnitsUsed: 0, wallClockMsUsed: 0, activeLoops: 0 },
      { computeUnits: 0, wallClockMs: 0, maxConcurrentLoops: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.exceeded).toBe("compute");
  });

  it("isolates tenants — one over quota does not affect another's decision (acceptance 2)", () => {
    const over = evaluateTenantQuota({ computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    const under = evaluateTenantQuota({ computeUnitsUsed: 5, wallClockMsUsed: 5_000, activeLoops: 1 }, QUOTA);
    expect(over.allowed).toBe(false);
    expect(under.allowed).toBe(true);
    // Re-evaluating the over-quota tenant does not change the under-quota tenant's independent decision.
    expect(evaluateTenantQuota({ computeUnitsUsed: 5, wallClockMsUsed: 5_000, activeLoops: 1 }, QUOTA)).toEqual(under);
  });
});

describe("evaluateTenantQuotaSoftWarnings (#7662)", () => {
  it("returns no warnings when every dimension is above the low threshold", () => {
    const decision = evaluateTenantQuota({ computeUnitsUsed: 70, wallClockMsUsed: 40_000, activeLoops: 1 }, QUOTA);
    expect(evaluateTenantQuotaSoftWarnings(decision, QUOTA)).toEqual([]);
  });

  it("warns at the low threshold (20% remaining) but not just above it", () => {
    const atThreshold = evaluateTenantQuota({ computeUnitsUsed: 80, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(evaluateTenantQuotaSoftWarnings(atThreshold, QUOTA)).toEqual([
      { dimension: "compute", severity: "low", remaining: 20, cap: 100 },
    ]);

    const aboveThreshold = evaluateTenantQuota({ computeUnitsUsed: 79, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(evaluateTenantQuotaSoftWarnings(aboveThreshold, QUOTA)).toEqual([]);
  });

  it("escalates to critical at 10% remaining and prefers critical over low", () => {
    const critical = evaluateTenantQuota({ computeUnitsUsed: 90, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(evaluateTenantQuotaSoftWarnings(critical, QUOTA)).toEqual([
      { dimension: "compute", severity: "critical", remaining: 10, cap: 100 },
    ]);
  });

  it("reports each exhausted-but-still-allowed dimension independently", () => {
    const decision = evaluateTenantQuota({ computeUnitsUsed: 85, wallClockMsUsed: 55_000, activeLoops: 2 }, QUOTA);
    expect(evaluateTenantQuotaSoftWarnings(decision, QUOTA)).toEqual([
      { dimension: "compute", severity: "low", remaining: 15, cap: 100 },
      { dimension: "time", severity: "critical", remaining: 5000, cap: 60_000 },
    ]);
  });

  it("returns no warnings once the tenant is hard-blocked", () => {
    const blocked = evaluateTenantQuota({ computeUnitsUsed: 100, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(blocked.allowed).toBe(false);
    expect(evaluateTenantQuotaSoftWarnings(blocked, QUOTA)).toEqual([]);
  });

  it("honors custom threshold fractions", () => {
    const decision = evaluateTenantQuota({ computeUnitsUsed: 50, wallClockMsUsed: 0, activeLoops: 0 }, QUOTA);
    expect(
      evaluateTenantQuotaSoftWarnings(decision, QUOTA, { lowRemainingFraction: 0.6, criticalRemainingFraction: 0.4 }),
    ).toEqual([{ dimension: "compute", severity: "low", remaining: 50, cap: 100 }]);
  });
});
