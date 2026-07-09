import { describe, expect, it } from "vitest";
import { DEFAULT_MINER_GOAL_SPEC, parseMinerGoalSpec } from "../../packages/gittensory-engine/src/miner-goal-spec";

// Parser coverage for the `feasibilityGate` policy block (#4275), mirroring the per-field present/absent/malformed
// style the other MinerGoalSpec fields are held to. The block reuses normalizeStringList for suppressReasons, so
// these focus on the block wrapper's own arms (absent, non-object, array, and a real object).
describe("parseMinerGoalSpec feasibilityGate (#4275)", () => {
  it("defaults to an empty suppress block when absent, without marking a bare spec present", () => {
    const parsed = parseMinerGoalSpec({});
    expect(parsed.present).toBe(false);
    expect(parsed.spec.feasibilityGate).toEqual({ suppressReasons: [] });
    // the shared default is not mutated
    expect(DEFAULT_MINER_GOAL_SPEC.feasibilityGate.suppressReasons).toEqual([]);
  });

  it("parses suppressReasons and marks the spec present when only feasibilityGate is set", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: { suppressReasons: ["duplicate_cluster_risk", "low_confidence"] } });
    expect(parsed.present).toBe(true);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.spec.feasibilityGate.suppressReasons).toEqual(["duplicate_cluster_risk", "low_confidence"]);
  });

  it("de-duplicates and skips non-string suppressReasons entries (via the shared list normalizer)", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: { suppressReasons: ["a", "a", 7, " b "] } });
    expect(parsed.spec.feasibilityGate.suppressReasons).toEqual(["a", "b"]);
    expect(parsed.warnings.some((w) => w.includes("feasibilityGate.suppressReasons"))).toBe(true);
  });

  it("degrades a non-object feasibilityGate to the empty block with a warning", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: "nope" });
    expect(parsed.spec.feasibilityGate).toEqual({ suppressReasons: [] });
    expect(parsed.warnings.some((w) => w.includes('field "feasibilityGate" must be a mapping'))).toBe(true);
  });

  it("degrades a list-valued feasibilityGate to the empty block, naming the value kind as 'list'", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: ["a"] });
    expect(parsed.spec.feasibilityGate).toEqual({ suppressReasons: [] });
    expect(parsed.warnings.some((w) => w.includes("ignoring a list value"))).toBe(true);
  });
});
