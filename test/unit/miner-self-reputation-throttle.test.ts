import { describe, expect, it } from "vitest";
import {
  selfReputationThrottle,
  DEFAULT_SELF_REPUTATION_THRESHOLDS,
} from "../../packages/gittensory-engine/src/index";

const FLOOR = DEFAULT_SELF_REPUTATION_THRESHOLDS.minCadenceMultiplier;

describe("self-reputation throttle (#2346)", () => {
  it("fails open on insufficient sample — a new miner / new repo is never throttled", () => {
    const v = selfReputationThrottle({ merged: 1, closed: 2 }); // sample 3 < minSample 4
    expect(v.cadenceMultiplier).toBe(1);
    expect(v.closeRatio).toBeNull();
    expect(v.reason).toBe("insufficient_sample");
  });

  it("allows full cadence on a clean / healthy track record", () => {
    const v = selfReputationThrottle({ merged: 9, closed: 1 }); // ratio 0.1 <= healthy 0.2
    expect(v.cadenceMultiplier).toBe(1);
    expect(v.reason).toBe("healthy");
    expect(v.closeRatio).toBe(0.1);
  });

  it("throttles to the floor at or above the critical close ratio", () => {
    const v = selfReputationThrottle({ merged: 2, closed: 8 }); // ratio 0.8 >= critical 0.6
    expect(v.cadenceMultiplier).toBe(FLOOR);
    expect(v.reason).toBe("critical");
  });

  it("degrades cadence linearly between the healthy and critical ratios", () => {
    const v = selfReputationThrottle({ merged: 6, closed: 4 }); // ratio 0.4, midway 0.2..0.6
    expect(v.reason).toBe("degrading");
    expect(v.closeRatio).toBe(0.4);
    expect(v.cadenceMultiplier).toBe(0.55); // 1 - 0.5*(1-0.1)
  });

  it("recovers cadence as the close ratio improves (monotonic)", () => {
    const worst = selfReputationThrottle({ merged: 4, closed: 6 }); // 0.6 ⇒ floor
    const better = selfReputationThrottle({ merged: 7, closed: 3 }); // 0.3 ⇒ degrading
    const best = selfReputationThrottle({ merged: 9, closed: 1 }); // 0.1 ⇒ full
    expect(better.cadenceMultiplier).toBeGreaterThan(worst.cadenceMultiplier);
    expect(best.cadenceMultiplier).toBeGreaterThan(better.cadenceMultiplier);
  });

  it("honors custom thresholds", () => {
    const v = selfReputationThrottle(
      { merged: 8, closed: 2 }, // ratio 0.2, between custom 0.1..0.3
      { minSample: 2, healthyCloseRatio: 0.1, criticalCloseRatio: 0.3, minCadenceMultiplier: 0.2 },
    );
    expect(v.reason).toBe("degrading");
  });

  it("rejects malformed inputs instead of silently coercing them", () => {
    expect(() => selfReputationThrottle({ merged: -1, closed: 2 })).toThrow(/outcomes\.merged/);
    expect(() => selfReputationThrottle({ merged: Number.NaN, closed: 2 })).toThrow(/outcomes\.merged/);
    expect(() =>
      selfReputationThrottle({ merged: 5, closed: 5 }, { ...DEFAULT_SELF_REPUTATION_THRESHOLDS, healthyCloseRatio: 0.6, criticalCloseRatio: 0.2 }),
    ).toThrow(/must exceed/);
    expect(() =>
      selfReputationThrottle({ merged: 5, closed: 5 }, { ...DEFAULT_SELF_REPUTATION_THRESHOLDS, minCadenceMultiplier: 1.5 }),
    ).toThrow(/minCadenceMultiplier/);
  });
});
