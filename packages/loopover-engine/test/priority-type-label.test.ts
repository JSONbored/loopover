import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PRIORITY_LABEL, gateConfigToJson, parseFocusManifest, resolvePriorityTypeLabel } from "../dist/index.js";

// The engine's own behaviour suite for the two surfaces #9738/#9743 added here. The root vitest suite
// covers them too, but the `engine` Codecov flag is fed by THIS suite -- and, more to the point, these are
// engine semantics, so they belong beside the rest of the engine's behaviour tests.

test("resolvePriorityTypeLabel: a repo's configured name wins (#9743)", () => {
  assert.equal(resolvePriorityTypeLabel({ bug: "b", feature: "f", priority: "team:top" }), "team:top");
});

test("resolvePriorityTypeLabel: falls back to the built-in default when unconfigured", () => {
  assert.equal(resolvePriorityTypeLabel(undefined), DEFAULT_PRIORITY_LABEL);
  assert.equal(resolvePriorityTypeLabel(null), DEFAULT_PRIORITY_LABEL);
  assert.equal(resolvePriorityTypeLabel({}), DEFAULT_PRIORITY_LABEL);
});

test("resolvePriorityTypeLabel: a blank configured name is unconfigured, not an empty label", () => {
  // An empty label would match nothing and silently disable both rules that key on it.
  for (const priority of ["", "   "]) {
    assert.equal(resolvePriorityTypeLabel({ bug: "b", feature: "f", priority }), DEFAULT_PRIORITY_LABEL);
  }
});

test("gateConfigToJson round-trips priorityEligibilityWindow (#9738)", () => {
  // The setting used to parse but never serialize, so it was silently dropped on the way back out.
  const parsed = parseFocusManifest({ gate: { priorityEligibilityWindow: 45 } });
  assert.equal(parsed.gate.priorityEligibilityWindowMinutes, 45);
  assert.equal((gateConfigToJson(parsed.gate) as { priorityEligibilityWindow?: number }).priorityEligibilityWindow, 45);
});

test("gateConfigToJson: 0 is an explicit OFF and must survive the round trip", () => {
  const parsed = parseFocusManifest({ gate: { priorityEligibilityWindow: 0 } });
  assert.equal(parsed.gate.priorityEligibilityWindowMinutes, 0);
  assert.equal((gateConfigToJson(parsed.gate) as { priorityEligibilityWindow?: number }).priorityEligibilityWindow, 0);
});
