import { describe, expect, it } from "vitest";
import {
  evaluateGovernorCaps,
  type GovernorCapLimits,
  type GovernorCapUsage,
} from "../../packages/gittensory-engine/src/governor/budget-cap";

// A generous set of ceilings; individual tests push one dimension past its cap.
const LIMITS: GovernorCapLimits = { budget: 100, turns: 20, elapsedMs: 60_000 };
const UNDER: GovernorCapUsage = { budgetSpent: 10, turnsTaken: 2, elapsedMs: 5_000 };

describe("evaluateGovernorCaps", () => {
  it("allows a run that is under every cap", () => {
    const r = evaluateGovernorCaps(UNDER, LIMITS);
    expect(r.verdict).toBe("allowed");
    expect(r.budget).toEqual({ limit: 100, used: 10, remaining: 90, exceeded: false });
    expect(r.turns).toEqual({ limit: 20, used: 2, remaining: 18, exceeded: false });
    expect(r.termination).toEqual({ limit: 60_000, used: 5_000, remaining: 55_000, exceeded: false });
  });

  it("denies when the budget cap is reached (at cap counts as exceeded, remaining clamps to 0)", () => {
    const r = evaluateGovernorCaps({ ...UNDER, budgetSpent: 100 }, LIMITS);
    expect(r.verdict).toBe("denied");
    expect(r.budget).toMatchObject({ used: 100, remaining: 0, exceeded: true });
    expect(r.turns.exceeded).toBe(false);
    expect(r.termination.exceeded).toBe(false);
  });

  it("denies when only the turn cap is exceeded (covers the right side of the budget||turns test)", () => {
    const r = evaluateGovernorCaps({ ...UNDER, turnsTaken: 25 }, LIMITS);
    expect(r.verdict).toBe("denied");
    expect(r.budget.exceeded).toBe(false);
    expect(r.turns).toMatchObject({ used: 25, remaining: 0, exceeded: true });
  });

  it("returns kill_switch when the termination ceiling is reached, even if budget/turns are also over", () => {
    const r = evaluateGovernorCaps({ budgetSpent: 999, turnsTaken: 999, elapsedMs: 60_000 }, LIMITS);
    expect(r.verdict).toBe("kill_switch");
    expect(r.termination).toMatchObject({ used: 60_000, remaining: 0, exceeded: true });
  });

  it("normalizes non-finite and negative inputs to 0 so no verdict is NaN or negative", () => {
    // Non-finite usage/limits exercise the non-finite arm of both normalizers; a negative value the clamp arm.
    const r = evaluateGovernorCaps(
      { budgetSpent: Number.NaN, turnsTaken: -5, elapsedMs: Number.POSITIVE_INFINITY },
      { budget: Number.POSITIVE_INFINITY, turns: Number.NaN, elapsedMs: -1 },
    );
    // budget: used 0 (NaN→0), limit 0 (Infinity→0) ⇒ 0 >= 0 ⇒ exceeded.
    expect(r.budget).toEqual({ limit: 0, used: 0, remaining: 0, exceeded: true });
    // turns: used 0 (-5→0), limit 0 (NaN→0) ⇒ exceeded.
    expect(r.turns).toEqual({ limit: 0, used: 0, remaining: 0, exceeded: true });
    // termination: used 0 (Infinity→0), limit 0 (-1→0) ⇒ exceeded ⇒ kill_switch wins.
    expect(r.termination).toEqual({ limit: 0, used: 0, remaining: 0, exceeded: true });
    expect(r.verdict).toBe("kill_switch");
    expect(Number.isFinite(r.budget.remaining)).toBe(true);
    expect(r.turns.remaining).toBeGreaterThanOrEqual(0);
  });

  it("floors a fractional turn count while keeping fractional budget/elapsed precision", () => {
    const r = evaluateGovernorCaps({ budgetSpent: 12.5, turnsTaken: 3.9, elapsedMs: 1_500.25 }, LIMITS);
    expect(r.turns.used).toBe(3); // floored
    expect(r.budget.used).toBe(12.5); // continuous precision retained
    expect(r.termination.used).toBe(1_500.25);
    expect(r.verdict).toBe("allowed");
  });
});
