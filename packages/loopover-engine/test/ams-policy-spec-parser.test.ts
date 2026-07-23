import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AMS_POLICY_SPEC_FILENAMES,
  DEFAULT_AMS_POLICY_SPEC,
  parseAmsPolicySpec,
  parseAmsPolicySpecContent,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the AmsPolicySpec parser API", () => {
  assert.equal(typeof parseAmsPolicySpec, "function");
  assert.equal(typeof parseAmsPolicySpecContent, "function");
  assert.deepEqual(AMS_POLICY_SPEC_FILENAMES, [
    ".loopover-ams.yml",
    ".github/loopover-ams.yml",
    ".loopover-ams.json",
    ".github/loopover-ams.json",
  ]);
});

test("parseAmsPolicySpec: missing raw input returns an absent safe-default spec with no warnings", () => {
  const parsed = parseAmsPolicySpec(undefined);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_AMS_POLICY_SPEC);
  assert.deepEqual(parsed.warnings, []);
});

test("parseAmsPolicySpec: a non-mapping raw value degrades to safe defaults with a warning", () => {
  const parsed = parseAmsPolicySpec(["not", "a", "mapping"]);
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_AMS_POLICY_SPEC);
  assert.match(parsed.warnings.join(" "), /must be a mapping/i);
});

test("parseAmsPolicySpec: valid raw config normalizes every field and keeps non-default input present", () => {
  const parsed = parseAmsPolicySpec({
    submissionMode: "enforce",
    slopThreshold: "clean",
    capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
    convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
    maxIterations: 5,
    maxTurnsPerIteration: 10,
    selfLoopAutonomy: "observe",
    networkAllowlist: { ecosystems: ["npm"], extraHosts: ["api.example.com"] },
  });

  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec, {
    submissionMode: "enforce",
    slopThreshold: "clean",
    capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
    convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
    maxIterations: 5,
    maxTurnsPerIteration: 10,
    selfLoopAutonomy: "observe",
    networkAllowlist: { ecosystems: ["npm"], extraHosts: ["api.example.com"] },
  });
  assert.deepEqual(parsed.warnings, []);
});

test("parseAmsPolicySpec: networkAllowlist (#7857) defaults to no additions and normalizes a valid declaration", () => {
  assert.deepEqual(DEFAULT_AMS_POLICY_SPEC.networkAllowlist, { ecosystems: [], extraHosts: [] });
  const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm", "pypi"], extraHosts: ["api.example.com"] } });
  assert.equal(parsed.present, true);
  assert.deepEqual(parsed.spec.networkAllowlist, { ecosystems: ["npm", "pypi"], extraHosts: ["api.example.com"] });
  assert.deepEqual(parsed.warnings, []);
});

test("parseAmsPolicySpec: selfLoopAutonomy defaults to auto when omitted (#6559)", () => {
  // "auto" is today's implicit behavior -- a clean self-review pass already hands off unconditionally -- so
  // this default is what keeps an unset field from silently changing an existing operator's loop.
  assert.equal(DEFAULT_AMS_POLICY_SPEC.selfLoopAutonomy, "auto");
  assert.equal(parseAmsPolicySpec({}).spec.selfLoopAutonomy, "auto");
});

test("parseAmsPolicySpec: selfLoopAutonomy accepts every valid level (#6559)", () => {
  // maxIterations rides along so the spec has a non-default field: with only selfLoopAutonomy: "auto" nothing
  // is configured, and the parser's own "nothing recognized" warning would mask the level's own parse.
  for (const level of ["observe", "auto_with_approval", "auto"]) {
    const parsed = parseAmsPolicySpec({ selfLoopAutonomy: level, maxIterations: 5 });
    assert.equal(parsed.spec.selfLoopAutonomy, level);
    assert.deepEqual(parsed.warnings, []);
  }
});

test("parseAmsPolicySpec: a non-default selfLoopAutonomy alone marks the spec present (#6559)", () => {
  const parsed = parseAmsPolicySpec({ selfLoopAutonomy: "observe" });
  assert.equal(parsed.present, true);
});

test("parseAmsPolicySpec: the default selfLoopAutonomy does not count as configured (#6559)", () => {
  const parsed = parseAmsPolicySpec({ selfLoopAutonomy: "auto" });
  assert.equal(parsed.present, false);
  assert.deepEqual(parsed.spec, DEFAULT_AMS_POLICY_SPEC);
});

test("parseAmsPolicySpec: an invalid selfLoopAutonomy falls back to auto with a warning (#6559)", () => {
  for (const value of ["yolo", 3, true, { level: "auto" }]) {
    const parsed = parseAmsPolicySpec({ selfLoopAutonomy: value, maxIterations: 5 });
    assert.equal(parsed.spec.selfLoopAutonomy, "auto");
    assert.match(parsed.warnings.join(" "), /selfLoopAutonomy/);
  }
});

test("parseAmsPolicySpec: maxIterations/maxTurnsPerIteration floor to whole counts and reject negative/non-numeric values", () => {
  const floored = parseAmsPolicySpec({ maxIterations: 4.9, maxTurnsPerIteration: 8.2 });
  assert.equal(floored.spec.maxIterations, 4);
  assert.equal(floored.spec.maxTurnsPerIteration, 8);
  assert.deepEqual(floored.warnings, []);

  const zero = parseAmsPolicySpec({ maxIterations: 0, submissionMode: "enforce" });
  assert.equal(zero.spec.maxIterations, 0);

  const negative = parseAmsPolicySpec({ maxIterations: -1 });
  assert.equal(negative.spec.maxIterations, DEFAULT_AMS_POLICY_SPEC.maxIterations);
  assert.match(negative.warnings.join(" "), /maxIterations/i);

  const nonNumeric = parseAmsPolicySpec({ maxTurnsPerIteration: "many" });
  assert.equal(nonNumeric.spec.maxTurnsPerIteration, DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration);
  assert.match(nonNumeric.warnings.join(" "), /maxTurnsPerIteration/i);
});

test("parseAmsPolicySpec: submissionMode rejects an unrecognized value", () => {
  const parsed = parseAmsPolicySpec({ submissionMode: "yolo" });
  assert.equal(parsed.spec.submissionMode, "observe");
  assert.match(parsed.warnings.join(" "), /submissionMode.*observe, enforce/i);
});

test("parseAmsPolicySpec: slopThreshold rejects an unrecognized value", () => {
  const parsed = parseAmsPolicySpec({ slopThreshold: "spicy" });
  assert.equal(parsed.spec.slopThreshold, "low");
  assert.match(parsed.warnings.join(" "), /slopThreshold.*clean, low, elevated, high/i);
});

test("parseAmsPolicySpec: capLimits normalizes independently, rejects negative/non-numeric fields, and rejects a non-mapping value", () => {
  const valid = parseAmsPolicySpec({ capLimits: { budget: 1, turns: 2, elapsedMs: 3 } });
  assert.deepEqual(valid.spec.capLimits, { budget: 1, turns: 2, elapsedMs: 3 });
  assert.deepEqual(valid.warnings, []);

  const negative = parseAmsPolicySpec({ capLimits: { budget: -1 } });
  assert.equal(negative.spec.capLimits.budget, DEFAULT_AMS_POLICY_SPEC.capLimits.budget);
  assert.match(negative.warnings.join(" "), /capLimits\.budget/i);

  const nonNumeric = parseAmsPolicySpec({ capLimits: { turns: "many" } });
  assert.equal(nonNumeric.spec.capLimits.turns, DEFAULT_AMS_POLICY_SPEC.capLimits.turns);
  assert.match(nonNumeric.warnings.join(" "), /capLimits\.turns/i);

  const arrayValue = parseAmsPolicySpec({ capLimits: ["not", "a", "mapping"] });
  assert.deepEqual(arrayValue.spec.capLimits, DEFAULT_AMS_POLICY_SPEC.capLimits);
  assert.match(arrayValue.warnings.join(" "), /capLimits.*must be a mapping/i);
});

test("parseAmsPolicySpec: convergenceThresholds normalizes independently and rejects a non-mapping value", () => {
  const valid = parseAmsPolicySpec({ convergenceThresholds: { maxConsecutiveFailures: 1, maxReenqueues: 1 } });
  assert.deepEqual(valid.spec.convergenceThresholds, { maxConsecutiveFailures: 1, maxReenqueues: 1 });

  const arrayValue = parseAmsPolicySpec({ convergenceThresholds: ["nope"] });
  assert.deepEqual(arrayValue.spec.convergenceThresholds, DEFAULT_AMS_POLICY_SPEC.convergenceThresholds);
  assert.match(arrayValue.warnings.join(" "), /convergenceThresholds.*must be a mapping/i);
});

test("parseAmsPolicySpecContent: JSON and YAML both parse, malformed content degrades to safe defaults", () => {
  const fromJson = parseAmsPolicySpecContent(JSON.stringify({ submissionMode: "enforce" }));
  assert.equal(fromJson.present, true);
  assert.equal(fromJson.spec.submissionMode, "enforce");

  const fromYaml = parseAmsPolicySpecContent("submissionMode: enforce\nslopThreshold: clean\n");
  assert.equal(fromYaml.present, true);
  assert.equal(fromYaml.spec.submissionMode, "enforce");
  assert.equal(fromYaml.spec.slopThreshold, "clean");

  const emptyContent = parseAmsPolicySpecContent("");
  assert.equal(emptyContent.present, false);
  assert.deepEqual(emptyContent.warnings, []);

  const nullContent = parseAmsPolicySpecContent(null);
  assert.equal(nullContent.present, false);

  const malformedJson = parseAmsPolicySpecContent("{ not valid json");
  assert.equal(malformedJson.present, false);
  assert.match(malformedJson.warnings.join(" "), /not valid JSON/i);

  const malformedYaml = parseAmsPolicySpecContent("submissionMode: [unterminated");
  assert.equal(malformedYaml.present, false);
  assert.match(malformedYaml.warnings.join(" "), /not valid YAML/i);

  const oversized = parseAmsPolicySpecContent("submissionMode: enforce\n# padding\n" + "x".repeat(9_000));
  assert.equal(oversized.present, false);
  assert.match(oversized.warnings.join(" "), /exceeded/i);
});
