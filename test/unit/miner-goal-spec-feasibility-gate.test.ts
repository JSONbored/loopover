import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpec,
} from "../../packages/gittensory-engine/src/miner-goal-spec";

describe("MinerGoalSpec feasibilityGate config block (#4275)", () => {
  it("defaults to an inert gate (score floor 0, nothing suppressed) when the block is absent", () => {
    const parsed = parseMinerGoalSpec({ minerEnabled: false });
    expect(parsed.spec.feasibilityGate).toEqual({ minFeasibilityScore: 0, suppressedAvoidReasons: [] });
    expect(DEFAULT_MINER_GOAL_SPEC.feasibilityGate).toEqual({ minFeasibilityScore: 0, suppressedAvoidReasons: [] });
  });

  it("normalizes a valid feasibilityGate and treats a gate-only config as present", () => {
    const parsed = parseMinerGoalSpec({
      feasibilityGate: {
        minFeasibilityScore: 0.4,
        suppressedAvoidReasons: ["missing_local_test_harness", " missing_local_test_harness ", "", "no_ci"],
      },
    });
    expect(parsed.present).toBe(true); // a feasibilityGate-only spec is non-default → present
    expect(parsed.spec.feasibilityGate).toEqual({
      minFeasibilityScore: 0.4,
      suppressedAvoidReasons: ["missing_local_test_harness", "no_ci"], // trimmed, de-duped, blanks dropped
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("clamps an out-of-range minFeasibilityScore into [0, 1] with a warning", () => {
    const high = parseMinerGoalSpec({ feasibilityGate: { minFeasibilityScore: 1.5 } });
    expect(high.spec.feasibilityGate.minFeasibilityScore).toBe(1);
    expect(high.warnings.join(" ")).toMatch(/minFeasibilityScore.*clamped to 1/i);

    const low = parseMinerGoalSpec({ feasibilityGate: { minFeasibilityScore: -0.5 } });
    expect(low.spec.feasibilityGate.minFeasibilityScore).toBe(0);
    expect(low.warnings.join(" ")).toMatch(/minFeasibilityScore.*clamped to 0/i);
  });

  it("rejects a non-finite / non-number minFeasibilityScore, falling back to 0 with a warning", () => {
    for (const bad of ["high", Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = parseMinerGoalSpec({ feasibilityGate: { minFeasibilityScore: bad as unknown as number } });
      expect(parsed.spec.feasibilityGate.minFeasibilityScore).toBe(0);
      expect(parsed.warnings.join(" ")).toMatch(/minFeasibilityScore.*must be a number/i);
    }
  });

  it("degrades a non-mapping feasibilityGate to the inert default with a warning", () => {
    for (const bad of [["nope"], "0.5", 42]) {
      const parsed = parseMinerGoalSpec({ feasibilityGate: bad as unknown });
      expect(parsed.spec.feasibilityGate).toEqual(DEFAULT_MINER_GOAL_SPEC.feasibilityGate);
      expect(parsed.warnings.join(" ")).toMatch(/feasibilityGate.*must be a mapping/i);
    }
  });

  it("tolerates a malformed suppressedAvoidReasons list (non-array → empty, with a warning)", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: { suppressedAvoidReasons: "no_ci" } });
    expect(parsed.spec.feasibilityGate.suppressedAvoidReasons).toEqual([]);
    expect(parsed.warnings.join(" ")).toMatch(/suppressedAvoidReasons.*must be a list/i);
  });
});
