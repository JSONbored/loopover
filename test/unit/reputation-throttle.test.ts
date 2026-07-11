import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELF_REPUTATION_THRESHOLDS,
  resolveSelfReputationThresholds,
  selfReputationThrottle,
  selfReputationThrottleLedgerEvent,
} from "../../packages/gittensory-engine/src/index";

describe("resolveSelfReputationThresholds (#2346)", () => {
  it("returns the conservative defaults when nothing is overridden", () => {
    expect(resolveSelfReputationThresholds()).toEqual(
      DEFAULT_SELF_REPUTATION_THRESHOLDS,
    );
  });

  it("applies a well-formed override verbatim", () => {
    expect(
      resolveSelfReputationThresholds({
        minSampleSize: 8,
        throttleAtRatio: 0.4,
        floorAtRatio: 0.8,
        minCadenceFactor: 0.2,
      }),
    ).toEqual({
      minSampleSize: 8,
      throttleAtRatio: 0.4,
      floorAtRatio: 0.8,
      minCadenceFactor: 0.2,
    });
  });

  it("normalizes malformed overrides (clamps ranges, floors sample size, keeps the band well-formed)", () => {
    expect(
      resolveSelfReputationThresholds({
        minSampleSize: 0, // → floored to 1
        throttleAtRatio: 2, // → clamped to 1
        floorAtRatio: 0.1, // → pulled up to throttleAtRatio (1)
        minCadenceFactor: -1, // → clamped to 0
      }),
    ).toEqual({
      minSampleSize: 1,
      throttleAtRatio: 1,
      floorAtRatio: 1,
      minCadenceFactor: 0,
    });
  });

  it("falls back to a default for a non-finite override value", () => {
    expect(
      resolveSelfReputationThresholds({ throttleAtRatio: Number.NaN })
        .throttleAtRatio,
    ).toBe(DEFAULT_SELF_REPUTATION_THRESHOLDS.throttleAtRatio);
  });
});

describe("selfReputationThrottle (#2346)", () => {
  it("fails open (full cadence) on insufficient history", () => {
    expect(selfReputationThrottle({ decided: 3, unfavorable: 3 })).toEqual({
      cadenceFactor: 1,
      throttled: false,
      unfavorableRatio: null,
      reason: "insufficient_history",
    });
  });

  it("treats a non-finite decided count as no history", () => {
    expect(
      selfReputationThrottle({ decided: Number.NaN, unfavorable: 5 }).reason,
    ).toBe("insufficient_history");
  });

  it("runs at full cadence for a clean track record", () => {
    expect(selfReputationThrottle({ decided: 10, unfavorable: 3 })).toEqual({
      cadenceFactor: 1,
      throttled: false,
      unfavorableRatio: 0.3,
      reason: "clean",
    });
  });

  it("degrades cadence linearly across the throttle band", () => {
    // ratio 0.7 in [0.5, 0.9): t = 0.5 → cadence 1 - 0.5*(1-0.1) = 0.55
    expect(selfReputationThrottle({ decided: 10, unfavorable: 7 })).toEqual({
      cadenceFactor: 0.55,
      throttled: true,
      unfavorableRatio: 0.7,
      reason: "throttled",
    });
  });

  it("pins cadence to the floor once the unfavorable ratio hits floorAtRatio", () => {
    expect(selfReputationThrottle({ decided: 10, unfavorable: 9 })).toEqual({
      cadenceFactor: 0.1,
      throttled: true,
      unfavorableRatio: 0.9,
      reason: "floored",
    });
  });

  it("clamps unfavorable to decided so a bad feed cannot exceed a 100% ratio", () => {
    const decision = selfReputationThrottle({ decided: 10, unfavorable: 20 });
    expect(decision.unfavorableRatio).toBe(1);
    expect(decision.reason).toBe("floored");
  });
});

describe("selfReputationThrottleLedgerEvent (#2346)", () => {
  it("records a throttled decision as a throttled ledger event", () => {
    const decision = selfReputationThrottle({ decided: 10, unfavorable: 9 });
    expect(
      selfReputationThrottleLedgerEvent("acme/widgets", "open_pr", decision),
    ).toEqual({
      eventType: "throttled",
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      decision: "throttle",
      reason: "floored",
      payload: { cadenceFactor: 0.1, unfavorableRatio: 0.9 },
    });
  });

  it("records an unthrottled decision as an allowed ledger event", () => {
    const decision = selfReputationThrottle({ decided: 10, unfavorable: 1 });
    const event = selfReputationThrottleLedgerEvent(
      "acme/widgets",
      "file_issue",
      decision,
    );
    expect(event.eventType).toBe("allowed");
    expect(event.decision).toBe("allow");
  });
});
