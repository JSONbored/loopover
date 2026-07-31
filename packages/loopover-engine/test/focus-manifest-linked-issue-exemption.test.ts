import assert from "node:assert/strict";
import { test } from "node:test";

import { gateConfigToJson, parseFocusManifest } from "../dist/focus-manifest.js";

// #10158 adds `gate.linkedIssueMaintainerExempt`. It lives in the ENGINE, which has its own c8 coverage run
// over dist/ with `--all`, so the root vitest suite's coverage of the same source does NOT satisfy the engine
// flag -- these lines need a test HERE or codecov/patch fails on lines that are in fact exercised.
//
// The clamp itself is root-side (src/settings/linked-issue-exemption.ts, tested there). What the engine owns
// is the three things that make the knob reachable at all: it parses, it survives a round-trip, and it is a
// RECOGNISED gate key. That last one is not a formality -- the key is validated against an allowlist
// (GATE_TOP_LEVEL_KEYS), and a knob added to the type and the parser but not the allowlist parses to its
// value and then warns "unknown key ...; ignoring it", i.e. is silently inert in every real config.

test("parses gate.linkedIssueMaintainerExempt as a tri-state boolean", () => {
  assert.equal(parseFocusManifest({ gate: { linkedIssueMaintainerExempt: true } }).gate.linkedIssueMaintainerExempt, true);
  assert.equal(parseFocusManifest({ gate: { linkedIssueMaintainerExempt: false } }).gate.linkedIssueMaintainerExempt, false);
});

test("is null when absent, so an unset knob leaves the DB/global value alone", () => {
  // null is "unset", distinct from false ("explicitly off"). resolveEffectiveSettings only overrides the
  // effective setting when this is non-null, so conflating the two would make every repo that never mentions
  // the key start overriding an inherited global with `false`.
  assert.equal(parseFocusManifest({ gate: { linkedIssue: "block" } }).gate.linkedIssueMaintainerExempt, null);
  assert.equal(parseFocusManifest({}).gate.linkedIssueMaintainerExempt, null);
});

test("REGRESSION: it is a RECOGNISED gate key — no 'unknown key' warning", () => {
  // The failure this pins is silent: without the GATE_TOP_LEVEL_KEYS entry the field still parses, so every
  // unit test on the parser passes, and the only symptom is a warning in the manifest guidance while the
  // knob does nothing in production.
  const warnings = parseFocusManifest({ gate: { linkedIssueMaintainerExempt: true } }).warnings;
  assert.deepEqual(warnings.filter((w) => w.includes("linkedIssueMaintainerExempt")), []);
});

test("warns and yields null on a non-boolean, rather than coercing a truthy string", () => {
  // A yml typo like `linkedIssueMaintainerExempt: yes-please` must not silently disable the linked-issue
  // gate for maintainers.
  const m = parseFocusManifest({ gate: { linkedIssueMaintainerExempt: "yes-please" } });
  assert.equal(m.gate.linkedIssueMaintainerExempt, null);
  assert.ok(m.warnings.some((w) => w.includes("gate.linkedIssueMaintainerExempt")));
});

test("round-trips through gateConfigToJson", () => {
  const parsed = parseFocusManifest({ gate: { linkedIssue: "block", linkedIssueMaintainerExempt: true } });
  const reparsed = parseFocusManifest({ gate: gateConfigToJson(parsed.gate) });
  assert.equal(reparsed.gate.linkedIssueMaintainerExempt, true);
  assert.equal(reparsed.gate.linkedIssue, "block");
});
