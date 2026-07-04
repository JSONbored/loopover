import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MINER_GOAL_SPEC } from "../dist/miner-goal-spec.js";
import { parseMinerGoalSpec } from "../dist/miner-goal-spec-parse.js";

test("parseMinerGoalSpec returns defaults for missing or non-object input", () => {
  for (const raw of [undefined, null, "nope", 42, []]) {
    const result = parseMinerGoalSpec(raw);
    assert.equal(result.present, false);
    assert.equal(result.spec, DEFAULT_MINER_GOAL_SPEC);
    assert.deepEqual(result.warnings, []);
  }
});

test("parseMinerGoalSpec coerces a full valid object and marks present", () => {
  const result = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: [" src/** ", "src/**"],
    blockedPaths: ["dist/**"],
    preferredLabels: [" bug ", "feature"],
    blockedLabels: [" wontfix ", "duplicate"],
    maxConcurrentClaims: 3,
    issueDiscoveryPolicy: "ENCOURAGED",
  });

  assert.equal(result.present, true);
  assert.deepEqual(result.spec, {
    minerEnabled: false,
    wantedPaths: ["src/**"],
    blockedPaths: ["dist/**"],
    preferredLabels: ["bug", "feature"],
    blockedLabels: ["wontfix", "duplicate"],
    maxConcurrentClaims: 3,
    issueDiscoveryPolicy: "encouraged",
  });
  assert.deepEqual(result.warnings, []);
  assert.ok(Object.isFrozen(result.spec));
  assert.ok(Object.isFrozen(result.spec.wantedPaths));
});

test("parseMinerGoalSpec floors claims and rejects values below 1", () => {
  const floored = parseMinerGoalSpec({ maxConcurrentClaims: 2.9 });
  assert.equal(floored.spec.maxConcurrentClaims, 2);

  const zero = parseMinerGoalSpec({ maxConcurrentClaims: 0 });
  assert.equal(zero.spec.maxConcurrentClaims, 1);
  assert.match(zero.warnings.join(" "), /maxConcurrentClaims/);
});

test("parseMinerGoalSpec warns and falls back on malformed fields", () => {
  const result = parseMinerGoalSpec({
    minerEnabled: "yes",
    wantedPaths: "src/**",
    maxConcurrentClaims: "two",
    issueDiscoveryPolicy: "aggressive",
  });

  assert.equal(result.present, true);
  assert.equal(result.spec.minerEnabled, DEFAULT_MINER_GOAL_SPEC.minerEnabled);
  assert.deepEqual(result.spec.wantedPaths, []);
  assert.equal(result.spec.maxConcurrentClaims, DEFAULT_MINER_GOAL_SPEC.maxConcurrentClaims);
  assert.equal(result.spec.issueDiscoveryPolicy, "neutral");
  assert.ok(result.warnings.length >= 4);
});

test("parseMinerGoalSpec caps list inspection for invalid entries", () => {
  const result = parseMinerGoalSpec({
    wantedPaths: Array.from({ length: 1_000 }, () => null),
  });

  assert.deepEqual(result.spec.wantedPaths, []);
  assert.equal(result.warnings.length, 201);
  assert.match(result.warnings.at(-1) ?? "", /capped at 200 entries/);
});

test("parseMinerGoalSpec caps list inspection for duplicate, empty, and overlong entries", () => {
  const duplicates = parseMinerGoalSpec({
    wantedPaths: Array.from({ length: 1_000 }, () => "src/**"),
  });
  assert.deepEqual(duplicates.spec.wantedPaths, ["src/**"]);
  assert.deepEqual(duplicates.warnings, [
    'MinerGoalSpec field "wantedPaths" is capped at 200 entries; dropping the rest.',
  ]);

  const empty = parseMinerGoalSpec({
    wantedPaths: Array.from({ length: 1_000 }, () => " "),
  });
  assert.deepEqual(empty.spec.wantedPaths, []);
  assert.deepEqual(empty.warnings, [
    'MinerGoalSpec field "wantedPaths" is capped at 200 entries; dropping the rest.',
  ]);

  const overlong = parseMinerGoalSpec({
    wantedPaths: Array.from({ length: 1_000 }, () => "x".repeat(301)),
  });
  assert.deepEqual(overlong.spec.wantedPaths, []);
  assert.deepEqual(overlong.warnings, [
    'MinerGoalSpec field "wantedPaths" is capped at 200 entries; dropping the rest.',
  ]);
});
