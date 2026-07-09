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
    blockedLabels: ["duplicate", " duplicate "],
    maxConcurrentClaims: 2.9,
    issueDiscoveryPolicy: "encouraged",
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    minerEnabled: false,
    wantedPaths: ["src/**", "docs/**"],
    blockedPaths: ["dist/**"],
    preferredLabels: ["help wanted", "gittensor:feature"],
    blockedLabels: ["duplicate"],
    maxConcurrentClaims: 2,
    issueDiscoveryPolicy: "encouraged",
    feasibilityGate: { suppressReasons: [] },
  });
  assert.deepEqual(parsed.warnings, []);
});

test("parseMinerGoalSpec: exactly 100 unique entries are accepted without a cap warning", () => {
  const wantedPaths = Array.from({ length: 100 }, (_, index) => `src/${index}.ts`);
  const parsed = parseMinerGoalSpec({ wantedPaths });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec.wantedPaths, wantedPaths);
  assert.ok(!parsed.warnings.some((warning) => /exceeded 100 entries/i.test(warning)));
});

test("parseMinerGoalSpec: caps inspection of a hostile all-non-string list instead of scanning it in full", () => {
  // Regression: the cap used to be checked only after a candidate was accepted (duplicate-check-adjacent), so
  // an array of entries that ALWAYS take the `continue` path (non-string, duplicate, or empty-after-trim) never
  // hit the cap and got fully scanned -- unbounded CPU/memory work and unbounded warnings for a hostile input.
  // The cap must be checked against the raw index, before any per-entry work. `minerEnabled: false` keeps the
  // spec "present" regardless of what wantedPaths ends up as, so these assertions stay focused on the list cap.
  const parsed = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: Array.from({ length: 1_000 }, () => null),
  });

  assert.deepEqual(parsed.spec.wantedPaths, []);
  assert.equal(parsed.warnings.length, 101);
  assert.match(parsed.warnings.at(-1) ?? "", /exceeded 100 entries/);
});

test("parseMinerGoalSpec: caps inspection of a hostile all-duplicate or all-empty list to a single cap warning", () => {
  const duplicates = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: Array.from({ length: 1_000 }, () => "src/**"),
  });
  assert.deepEqual(duplicates.spec.wantedPaths, ["src/**"]);
  assert.deepEqual(duplicates.warnings, [
    'MinerGoalSpec field "wantedPaths" exceeded 100 entries; extra entries ignored.',
  ]);

  const empty = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: Array.from({ length: 1_000 }, () => "   "),
  });
  assert.deepEqual(empty.spec.wantedPaths, []);
  assert.deepEqual(empty.warnings, [
    'MinerGoalSpec field "wantedPaths" exceeded 100 entries; extra entries ignored.',
  ]);
});

test("parseMinerGoalSpec: caps inspection of a hostile all-overlong list, even though each entry still warns once", () => {
  // Different from the duplicate/empty case: an overlong entry is TRUNCATED (with its own warning), not
  // silently dropped, so every one of the 100 inspected entries produces a truncation warning before the
  // post-truncation duplicate check collapses them into one result entry. Still bounded to exactly
  // 100 truncate warnings + 1 cap warning, never proportional to the input's true length.
  const parsed = parseMinerGoalSpec({
    minerEnabled: false,
    wantedPaths: Array.from({ length: 1_000 }, () => "x".repeat(300)),
  });

  assert.deepEqual(parsed.spec.wantedPaths, ["x".repeat(256)]);
  assert.equal(parsed.warnings.length, 101);
  assert.match(parsed.warnings.at(-1) ?? "", /exceeded 100 entries/);
});

test("parseMinerGoalSpec: malformed fields fall back independently with targeted warnings", () => {
  const longEntry = "x".repeat(300);
  const parsed = parseMinerGoalSpec({
    minerEnabled: "yes",
    wantedPaths: "src/**",
    blockedPaths: [123, " dist/** ", "", longEntry],
    preferredLabels: [false, "bugfix"],
    blockedLabels: [123, " wontfix "],
    maxConcurrentClaims: 0.9,
    issueDiscoveryPolicy: "always",
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    minerEnabled: true,
    wantedPaths: [],
    blockedPaths: ["dist/**", longEntry.slice(0, 256)],
    preferredLabels: ["bugfix"],
    blockedLabels: ["wontfix"],
    maxConcurrentClaims: 1,
    issueDiscoveryPolicy: "neutral",
    feasibilityGate: { suppressReasons: [] },
  });
  const warningText = parsed.warnings.join(" ");
  assert.match(warningText, /minerEnabled/i);
  assert.match(warningText, /wantedPaths/i);
  assert.match(warningText, /blockedPaths/i);
  assert.match(warningText, /preferredLabels/i);
  assert.match(warningText, /blockedLabels/i);
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
    blockedLabels: [],
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

  const twoByteOversized = parseMinerGoalSpecContent(`wantedPaths:\n  - ${"é".repeat(17_000)}\n`);
  assert.equal(twoByteOversized.present, false);
  assert.match(twoByteOversized.warnings.join(" "), /exceeded 32768 bytes/i);

  const fourByteOversized = parseMinerGoalSpecContent(`wantedPaths:\n  - ${"🙂".repeat(9_000)}\n`);
  assert.equal(fourByteOversized.present, false);
  assert.match(fourByteOversized.warnings.join(" "), /exceeded 32768 bytes/i);
});
