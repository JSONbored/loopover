import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MINER_GOAL_SPEC, type MinerGoalSpec } from "../dist/miner-goal-spec.js";
import { computeLaneFit, type GoalModelInput } from "../dist/goal-model.js";

function baseSpec(overrides: Partial<MinerGoalSpec> = {}): MinerGoalSpec {
  return { ...DEFAULT_MINER_GOAL_SPEC, ...overrides };
}

function input(overrides: Partial<GoalModelInput> = {}): GoalModelInput {
  return {
    candidatePaths: ["src/app.ts"],
    candidateLabels: ["bug"],
    goalSpec: baseSpec(),
    ...overrides,
  };
}

test("computeLaneFit returns 0 when a candidate path matches a blockedPath (short-circuit, ignores preferredLanes)", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["secrets/api-keys.ts"],
      goalSpec: baseSpec({ blockedPaths: ["secrets/**"], wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 0);
});

test("computeLaneFit returns 0 when a candidate label matches a blockedLabel", () => {
  const result = computeLaneFit(
    input({
      candidateLabels: ["do-not-pick"],
      goalSpec: baseSpec({ blockedLabels: ["do-not-pick"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 0);
});

test("computeLaneFit returns 0.5 when wantedPaths and preferredLabels are both empty (neutral default)", () => {
  const result = computeLaneFit(input());
  assert.equal(result, 0.5);
});

test("computeLaneFit returns 0 when wantedPaths/preferredLabels are set but no match", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["docs/readme.md"],
      candidateLabels: [],
      goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 0);
});

test("computeLaneFit returns 1.0 when both wantedPaths and preferredLabels fully match", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["src/app.ts"],
      candidateLabels: ["bug"],
      goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit returns 0.5 when only one of two preferred criteria matches (path match, label miss)", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["src/app.ts"],
      candidateLabels: ["unrelated"],
      goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 0.5);
});

test("computeLaneFit returns 0.5 when only one of two preferred criteria matches (label match, path miss)", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["docs/readme.md"],
      candidateLabels: ["bug"],
      goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 0.5);
});

test("computeLaneFit returns 1.0 when multiple wantedPaths are set and one matches", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["src/app.ts"],
      candidateLabels: [],
      goalSpec: baseSpec({ wantedPaths: ["src/**", "lib/**", "packages/**"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit returns 1.0 when multiple preferredLabels are set and one matches", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: [],
      candidateLabels: ["bug"],
      goalSpec: baseSpec({ preferredLabels: ["bug", "feature", "enhancement"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit returns 1.0 when both multi-entry lists have at least one match", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["lib/utils.ts"],
      candidateLabels: ["enhancement"],
      goalSpec: baseSpec({
        wantedPaths: ["src/**", "lib/**", "packages/**"],
        preferredLabels: ["bug", "feature", "enhancement"],
      }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit returns 1.0 when only wantedPaths is set and matches", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: ["src/app.ts"],
      candidateLabels: [],
      goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit returns 1.0 when only preferredLabels is set and matches", () => {
  const result = computeLaneFit(
    input({
      candidatePaths: [],
      candidateLabels: ["bug"],
      goalSpec: baseSpec({ preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit treats label matching case-insensitively", () => {
  const result = computeLaneFit(
    input({
      candidateLabels: ["BUG"],
      goalSpec: baseSpec({ preferredLabels: ["bug"] }),
    }),
  );
  assert.equal(result, 1);
});

test("computeLaneFit ** glob matches both top-level and nested paths", () => {
  const topLevel = computeLaneFit(
    input({
      candidatePaths: ["src/app.ts"],
      candidateLabels: [],
      goalSpec: baseSpec({ wantedPaths: ["src/**/*.ts"] }),
    }),
  );
  assert.equal(topLevel, 1);

  const nested = computeLaneFit(
    input({
      candidatePaths: ["src/nested/app.ts"],
      candidateLabels: [],
      goalSpec: baseSpec({ wantedPaths: ["src/**/*.ts"] }),
    }),
  );
  assert.equal(nested, 1);
});