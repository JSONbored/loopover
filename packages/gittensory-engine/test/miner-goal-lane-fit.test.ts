import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MINER_GOAL_SPEC } from "../dist/miner-goal-spec.js";
import { computeMinerGoalLaneFit, isMinerRepoTargetable } from "../dist/miner-goal-lane-fit.js";

test("isMinerRepoTargetable respects minerEnabled opt-out", () => {
  assert.equal(isMinerRepoTargetable(DEFAULT_MINER_GOAL_SPEC), true);
  assert.equal(isMinerRepoTargetable({ ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false }), false);
});

test("computeMinerGoalLaneFit returns 1 when no preferred labels are configured", () => {
  assert.equal(computeMinerGoalLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC), 1);
});

test("computeMinerGoalLaneFit matches preferred labels case-insensitively", () => {
  const spec = { ...DEFAULT_MINER_GOAL_SPEC, preferredLabels: ["bug"] };
  assert.equal(computeMinerGoalLaneFit({ labels: ["Bug"] }, spec), 1);
  assert.equal(computeMinerGoalLaneFit({ labels: ["feature"] }, spec), 0.25);
});

test("computeMinerGoalLaneFit applies issueDiscoveryPolicy modifiers", () => {
  const encouraged = {
    ...DEFAULT_MINER_GOAL_SPEC,
    preferredLabels: ["feature"],
    issueDiscoveryPolicy: "encouraged" as const,
  };
  assert.equal(computeMinerGoalLaneFit({ labels: ["docs"] }, encouraged), 0.85);

  const discouraged = {
    ...DEFAULT_MINER_GOAL_SPEC,
    preferredLabels: ["feature"],
    issueDiscoveryPolicy: "discouraged" as const,
  };
  assert.equal(computeMinerGoalLaneFit({ labels: ["docs"] }, discouraged), 0.6);
  assert.equal(computeMinerGoalLaneFit({ labels: ["feature"] }, discouraged), 1);
});

test("computeMinerGoalLaneFit returns 0 when a blocked label matches case-insensitively", () => {
  const spec = { ...DEFAULT_MINER_GOAL_SPEC, blockedLabels: ["wontfix"] };
  assert.equal(computeMinerGoalLaneFit({ labels: ["WontFix"] }, spec), 0);
  assert.equal(computeMinerGoalLaneFit({ labels: ["bug"] }, spec), 1);
});

test("computeMinerGoalLaneFit ignores malformed label entries safely", () => {
  assert.equal(
    computeMinerGoalLaneFit({ labels: ["bug", "", 42 as unknown as string, "  "] }, {
      ...DEFAULT_MINER_GOAL_SPEC,
      preferredLabels: ["BUG"],
    }),
    1,
  );
});
