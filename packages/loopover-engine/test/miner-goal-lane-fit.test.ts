import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MINER_GOAL_SPEC } from "../dist/miner-goal-spec.js";
import { computeMetadataLaneFit, computeMinerGoalLaneFit, isMinerRepoTargetable } from "../dist/miner-goal-lane-fit.js";

test("isMinerRepoTargetable respects minerEnabled opt-out", () => {
  assert.equal(isMinerRepoTargetable(DEFAULT_MINER_GOAL_SPEC), true);
  assert.equal(isMinerRepoTargetable({ ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false }), false);
});

test("computeMinerGoalLaneFit returns the neutral 0.5 when no preferred labels are configured", () => {
  assert.equal(computeMinerGoalLaneFit({ labels: ["docs"] }, DEFAULT_MINER_GOAL_SPEC), 0.5);
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
  assert.equal(computeMinerGoalLaneFit({ labels: ["bug"] }, spec), 0.5);
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

test("computeMetadataLaneFit falls back to label-only lane fit when candidatePaths are absent", () => {
  const spec = { ...DEFAULT_MINER_GOAL_SPEC, preferredLabels: ["bug"] };
  assert.equal(computeMetadataLaneFit({ labels: ["bug"] }, spec), 1);
  assert.equal(computeMetadataLaneFit({ labels: ["feature"] }, spec), 0.25);
});

test("computeMetadataLaneFit uses computeLaneFit when candidatePaths are present", () => {
  const spec = {
    ...DEFAULT_MINER_GOAL_SPEC,
    wantedPaths: ["src/**"],
    preferredLabels: ["bug"],
  };
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: ["src/app.ts"] },
      spec,
    ),
    1,
  );
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: ["docs/readme.md"] },
      spec,
    ),
    0.5,
  );
});

test("computeMetadataLaneFit returns 0 when candidatePaths hit blockedPaths", () => {
  const spec = {
    ...DEFAULT_MINER_GOAL_SPEC,
    blockedPaths: ["secrets/**"],
    wantedPaths: ["src/**"],
  };
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: ["secrets/api-keys.ts"] },
      spec,
    ),
    0,
  );
});

test("computeMetadataLaneFit ignores malformed candidatePaths values", () => {
  const spec = {
    ...DEFAULT_MINER_GOAL_SPEC,
    blockedPaths: ["src/**"],
    preferredLabels: ["bug"],
    wantedPaths: ["src/**"],
  };
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: ["", "  ", 42 as unknown as string] },
      spec,
    ),
    1,
  );
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: { path: "src/app.ts" } as unknown as string[] },
      spec,
    ),
    1,
  );
  assert.equal(
    computeMetadataLaneFit(
      { labels: ["bug"], candidatePaths: "src/app.ts" as unknown as string[] },
      spec,
    ),
    1,
  );
});
