import { describe, expect, it } from "vitest";
import {
  computeMinerGoalLaneFit,
  DEFAULT_MINER_GOAL_SPEC,
  isMinerRepoTargetable,
} from "../../packages/gittensory-engine/src/index";

describe("computeMinerGoalLaneFit", () => {
  it("respects minerEnabled opt-out", () => {
    expect(isMinerRepoTargetable(DEFAULT_MINER_GOAL_SPEC)).toBe(true);
    expect(isMinerRepoTargetable({ ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false })).toBe(false);
  });

  it("returns 0 when a blocked label matches case-insensitively", () => {
    const spec = { ...DEFAULT_MINER_GOAL_SPEC, blockedLabels: ["wontfix", "duplicate"] };
    expect(computeMinerGoalLaneFit({ labels: ["WontFix"] }, spec)).toBe(0);
    expect(computeMinerGoalLaneFit({ labels: ["DUPLICATE"] }, spec)).toBe(0);
  });

  it("continues scoring when blocked labels are configured but none match", () => {
    const spec = { ...DEFAULT_MINER_GOAL_SPEC, blockedLabels: ["wontfix"], preferredLabels: ["bug"] };
    expect(computeMinerGoalLaneFit({ labels: ["bug"] }, spec)).toBe(1);
    expect(computeMinerGoalLaneFit({ labels: ["feature"] }, spec)).toBe(0.25);
  });

  it("scores normally when no blocked labels are configured", () => {
    expect(computeMinerGoalLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC)).toBe(1);
  });
});
