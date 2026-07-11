// Tests for the MinerGoalSpec type contract (#2293). Types-only module, so these assert (a) the safe-defaults
// constant's runtime values, (b) that it satisfies the MinerGoalSpec type, and (c) a lightweight "every field is
// documented with a Default:" lint over the source — not parser behavior (that lands in a separate issue).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_MINER_GOAL_SPEC, type MinerGoalSpec } from "../dist/index.js";

// Compile-time contract: the exported default must satisfy MinerGoalSpec (fails `tsc` if the shape drifts).
const _contract: MinerGoalSpec = DEFAULT_MINER_GOAL_SPEC;
void _contract;

test("DEFAULT_MINER_GOAL_SPEC carries the documented safe defaults", () => {
  assert.deepEqual(DEFAULT_MINER_GOAL_SPEC, {
    minerEnabled: true, // opt-out, not opt-in: a repo with no file is still minable
    wantedPaths: [],
    blockedPaths: [],
    preferredLabels: [],
    blockedLabels: [],
    maxConcurrentClaims: 1,
    issueDiscoveryPolicy: "neutral",
    feasibilityGate: { enabled: true, suppressedReasons: [] },
    selfPlagiarism: Object.freeze({ similarityThreshold: 0.85 }),
  });
});

test("DEFAULT_MINER_GOAL_SPEC is deep-frozen so the shared singleton can't be mutated", () => {
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.wantedPaths));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.blockedPaths));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.preferredLabels));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.blockedLabels));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.feasibilityGate));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.feasibilityGate.suppressedReasons));
  assert.ok(Object.isFrozen(DEFAULT_MINER_GOAL_SPEC.selfPlagiarism));
});

test("DEFAULT_MINER_GOAL_SPEC exposes exactly the specified field surface", () => {
  assert.deepEqual(Object.keys(DEFAULT_MINER_GOAL_SPEC).sort(), [
    "blockedLabels",
    "blockedPaths",
    "feasibilityGate",
    "issueDiscoveryPolicy",
    "maxConcurrentClaims",
    "minerEnabled",
    "preferredLabels",
    "selfPlagiarism",
    "wantedPaths",
  ]);
});

test("every MinerGoalSpec field is documented with a JSDoc 'Default:' in the source", () => {
  // The suite compiles to dist-test/ (tsconfig.test.json outDir), a sibling of src/, so ../src/ from this file's
  // runtime location resolves to the TypeScript source. readFileSync throws loudly if that layout ever changes, so
  // this test can't silently pass on a bad path.
  const source = readFileSync(new URL("../src/miner-goal-spec.ts", import.meta.url), "utf8");
  const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const field of Object.keys(DEFAULT_MINER_GOAL_SPEC)) {
    // Grab the JSDoc block immediately preceding the field declaration inside the type. Field names are escaped
    // before interpolation so the pattern stays safe if it is ever reused for a less controlled field surface.
    const doc = source.match(new RegExp(`(/\\*\\*[\\s\\S]*?\\*/)\\s*\\n\\s*${escapeRe(field)}:`));
    const jsdoc = doc?.[1];
    assert.ok(jsdoc, `field '${field}' should have a JSDoc block`);
    assert.match(jsdoc, /Default:/, `field '${field}' JSDoc should state its Default:`);
  }
});
