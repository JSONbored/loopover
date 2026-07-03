import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpec,
  parseMinerGoalSpecContent,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the MinerGoalSpec parser API", () => {
  assert.equal(typeof parseMinerGoalSpec, "function");
  assert.equal(typeof parseMinerGoalSpecContent, "function");
});

test("parseMinerGoalSpec: missing raw input returns an absent safe-default spec with no warnings", () => {
  const parsed = parseMinerGoalSpec(undefined);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_MINER_GOAL_SPEC);
  assert.deepEqual(parsed.warnings, []);
});

test("parseMinerGoalSpec: a non-mapping raw value degrades to safe defaults with a warning", () => {
  const parsed = parseMinerGoalSpec(["not", "a", "mapping"]);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_MINER_GOAL_SPEC);
  assert.match(parsed.warnings.join(" "), /must be a mapping/i);
});

test("parseMinerGoalSpec: valid raw config normalizes every field and keeps non-default input present", () => {
  const parsed = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: ["src/**", " src/** ", "", "docs/**"],
    blockedPaths: ["dist/**"],
    preferredLabels: ["help wanted", "help wanted", "gittensor:feature"],
    maxConcurrentClaims: 2.9,
    issueDiscoveryPolicy: "encouraged",
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    minerEnabled: false,
    wantedPaths: ["src/**", "docs/**"],
    blockedPaths: ["dist/**"],
    preferredLabels: ["help wanted", "gittensor:feature"],
    maxConcurrentClaims: 2,
    issueDiscoveryPolicy: "encouraged",
  });
  assert.deepEqual(parsed.warnings, []);
});

test("parseMinerGoalSpec: malformed fields fall back independently with targeted warnings", () => {
  const longEntry = "x".repeat(300);
  const parsed = parseMinerGoalSpec({
    minerEnabled: "yes",
    wantedPaths: "src/**",
    blockedPaths: [123, " dist/** ", "", longEntry],
    preferredLabels: [false, "bugfix"],
    maxConcurrentClaims: 0.9,
    issueDiscoveryPolicy: "always",
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    minerEnabled: true,
    wantedPaths: [],
    blockedPaths: ["dist/**", longEntry.slice(0, 256)],
    preferredLabels: ["bugfix"],
    maxConcurrentClaims: 1,
    issueDiscoveryPolicy: "neutral",
  });
  const warningText = parsed.warnings.join(" ");
  assert.match(warningText, /minerEnabled/i);
  assert.match(warningText, /wantedPaths/i);
  assert.match(warningText, /blockedPaths/i);
  assert.match(warningText, /preferredLabels/i);
  assert.match(warningText, /maxConcurrentClaims/i);
  assert.match(warningText, /issueDiscoveryPolicy/i);
  assert.match(warningText, /truncated an over-long entry/i);
});

test("parseMinerGoalSpec: unknown-only or default-only content stays absent with a fallback warning", () => {
  const unknownOnly = parseMinerGoalSpec({ mystery: true });
  assert.equal(unknownOnly.present, false);
  assert.deepEqual(unknownOnly.spec, DEFAULT_MINER_GOAL_SPEC);
  assert.match(unknownOnly.warnings.join(" "), /no recognized non-default goal fields/i);

  const explicitDefaults = parseMinerGoalSpec({
    minerEnabled: true,
    wantedPaths: [],
    blockedPaths: [],
    preferredLabels: [],
    maxConcurrentClaims: 1,
    issueDiscoveryPolicy: "neutral",
  });
  assert.equal(explicitDefaults.present, false);
  assert.deepEqual(explicitDefaults.spec, DEFAULT_MINER_GOAL_SPEC);
  assert.match(explicitDefaults.warnings.join(" "), /no recognized non-default goal fields/i);
});

test("parseMinerGoalSpecContent: empty content returns an absent default spec", () => {
  for (const value of ["", "   ", null, undefined]) {
    const parsed = parseMinerGoalSpecContent(value);
    assert.equal(parsed.present, false);
    assert.deepEqual(parsed.spec, DEFAULT_MINER_GOAL_SPEC);
    assert.deepEqual(parsed.warnings, []);
  }
});

test("parseMinerGoalSpecContent: parses valid JSON and YAML content", () => {
  const json = parseMinerGoalSpecContent(
    JSON.stringify({
      wantedPaths: ["src/**"],
      preferredLabels: ["gittensor:feature"],
      maxConcurrentClaims: 3,
    }),
  );
  assert.equal(json.present, true);
  assert.deepEqual(json.spec.wantedPaths, ["src/**"]);
  assert.deepEqual(json.spec.preferredLabels, ["gittensor:feature"]);
  assert.equal(json.spec.maxConcurrentClaims, 3);

  const yaml = parseMinerGoalSpecContent(
    "minerEnabled: false\nblockedPaths:\n  - dist/**\nissueDiscoveryPolicy: discouraged\n",
  );
  assert.equal(yaml.present, true);
  assert.equal(yaml.spec.minerEnabled, false);
  assert.deepEqual(yaml.spec.blockedPaths, ["dist/**"]);
  assert.equal(yaml.spec.issueDiscoveryPolicy, "discouraged");
});

test("parseMinerGoalSpecContent: malformed JSON and YAML warn instead of throwing", () => {
  const badJson = parseMinerGoalSpecContent("{ invalid json");
  assert.equal(badJson.present, false);
  assert.match(badJson.warnings.join(" "), /not valid JSON/i);

  const badYaml = parseMinerGoalSpecContent("wantedPaths: [unterminated");
  assert.equal(badYaml.present, false);
  assert.match(badYaml.warnings.join(" "), /not valid YAML/i);
});

test("parseMinerGoalSpecContent: non-mapping parsed content and oversized content degrade safely", () => {
  const notMapping = parseMinerGoalSpecContent('["src/**"]');
  assert.equal(notMapping.present, false);
  assert.match(notMapping.warnings.join(" "), /must be a mapping/i);

  const oversized = parseMinerGoalSpecContent(`wantedPaths:\n  - ${"x".repeat(40_000)}\n`);
  assert.equal(oversized.present, false);
  assert.match(oversized.warnings.join(" "), /exceeded 32768 bytes/i);

  const multibyteOversized = parseMinerGoalSpecContent(`wantedPaths:\n  - ${"好".repeat(12_000)}\n`);
  assert.equal(multibyteOversized.present, false);
  assert.match(multibyteOversized.warnings.join(" "), /exceeded 32768 bytes/i);
});
