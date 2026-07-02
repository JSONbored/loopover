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
    maxConcurrentClaims: 1,
    issueDiscoveryPolicy: "neutral",
  });
});

test("DEFAULT_MINER_GOAL_SPEC exposes exactly the specified field surface", () => {
  assert.deepEqual(Object.keys(DEFAULT_MINER_GOAL_SPEC).sort(), [
    "blockedPaths",
    "issueDiscoveryPolicy",
    "maxConcurrentClaims",
    "minerEnabled",
    "preferredLabels",
    "wantedPaths",
  ]);
});

test("every MinerGoalSpec field is documented with a JSDoc 'Default:' in the source", () => {
  const source = readFileSync(new URL("../src/miner-goal-spec.ts", import.meta.url), "utf8");
  for (const field of Object.keys(DEFAULT_MINER_GOAL_SPEC)) {
    // Grab the JSDoc block immediately preceding the field declaration inside the type.
    const doc = source.match(new RegExp(`(/\\*\\*[\\s\\S]*?\\*/)\\s*\\n\\s*${field}:`));
    const jsdoc = doc?.[1];
    assert.ok(jsdoc, `field '${field}' should have a JSDoc block`);
    assert.match(jsdoc, /Default:/, `field '${field}' JSDoc should state its Default:`);
  }
});
