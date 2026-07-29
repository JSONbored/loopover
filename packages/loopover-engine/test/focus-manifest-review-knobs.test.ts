import assert from "node:assert/strict";
import { test } from "node:test";

import { gateConfigToJson, parseFocusManifest } from "../dist/focus-manifest.js";

// #9821 added per-repo `gate.aiReview.effort`/`selfConsistencyRuns` and the `gate.guardrailEscalation` block.
// These live in the ENGINE, which has its own c8 coverage run over dist/ with `--all` — so every line counts
// whether or not a test loads it, and the root vitest suite's coverage of the same source does NOT satisfy it
// (that report only instruments the 11 lines it actually executes; the engine report instruments all 66).
// Codecov merges both, so the engine's own suite has to exercise these branches or they read as uncovered.

test("parses the new aiReview knobs and the guardrailEscalation block", () => {
  const parsed = parseFocusManifest({
    gate: {
      aiReview: { effort: "high", selfConsistencyRuns: 3 },
      guardrailEscalation: { provider: "anthropic", model: "claude-opus-5", effort: "xhigh", selfConsistencyRuns: 2 },
    },
  });
  assert.equal(parsed.gate.present, true);
  assert.equal(parsed.gate.aiReviewEffort, "high");
  assert.equal(parsed.gate.aiReviewSelfConsistencyRuns, 3);
  assert.equal(parsed.gate.guardrailEscalationProvider, "anthropic");
  assert.equal(parsed.gate.guardrailEscalationModel, "claude-opus-5");
  assert.equal(parsed.gate.guardrailEscalationEffort, "xhigh");
  assert.equal(parsed.gate.guardrailEscalationSelfConsistencyRuns, 2);
});

test("each new field ALONE makes the gate present", () => {
  // The #9813 presence-gap class, per field: a gate block setting only one of these must not parse as absent,
  // or the whole block is silently discarded.
  for (const gate of [
    { aiReview: { effort: "low" } },
    { aiReview: { selfConsistencyRuns: 0 } },
    { guardrailEscalation: { provider: "openai" } },
    { guardrailEscalation: { model: "m" } },
    { guardrailEscalation: { effort: "max" } },
    { guardrailEscalation: { selfConsistencyRuns: 3 } },
  ]) {
    assert.equal(parseFocusManifest({ gate }).gate.present, true, JSON.stringify(gate));
  }
});

test("serialize round-trips the new fields, full and partial", () => {
  // The serialize guard was genuinely broken until a round-trip assertion caught it: an aiReview block setting
  // ONLY effort/selfConsistencyRuns emitted nothing, so the setting vanished on the next snapshot reload.
  for (const gate of [
    { aiReview: { effort: "high", selfConsistencyRuns: 3 }, guardrailEscalation: { effort: "xhigh", selfConsistencyRuns: 2, provider: "anthropic", model: "m" } },
    { aiReview: { effort: "medium" } },
    { aiReview: { selfConsistencyRuns: 2 } },
    { guardrailEscalation: { effort: "high" } },
    { guardrailEscalation: { selfConsistencyRuns: 3 } },
  ]) {
    const parsed = parseFocusManifest({ gate });
    const round = parseFocusManifest({ gate: gateConfigToJson(parsed.gate) });
    assert.deepEqual(round.gate, parsed.gate, JSON.stringify(gate));
  }
});

test("invalid values warn and stay null rather than being coerced", () => {
  const parsed = parseFocusManifest({
    gate: {
      aiReview: { effort: "ultra", selfConsistencyRuns: -1 },
      guardrailEscalation: { provider: "grok", effort: 7, selfConsistencyRuns: "three", model: 42 },
    },
  });
  assert.equal(parsed.gate.aiReviewEffort, null);
  assert.equal(parsed.gate.aiReviewSelfConsistencyRuns, null);
  assert.equal(parsed.gate.guardrailEscalationProvider, null);
  assert.equal(parsed.gate.guardrailEscalationEffort, null);
  assert.equal(parsed.gate.guardrailEscalationSelfConsistencyRuns, null);
  assert.equal(parsed.gate.guardrailEscalationModel, null);
  assert.ok(parsed.warnings.some((w) => /gate\.aiReview\.effort/.test(w)));
  assert.ok(parsed.warnings.some((w) => /gate\.guardrailEscalation\.provider/.test(w)));
});

test("a non-mapping guardrailEscalation is ignored wholesale, and absence leaves every field null", () => {
  const notMapping = parseFocusManifest({ gate: { guardrailEscalation: "high", claMode: "advisory" } });
  assert.equal(notMapping.gate.guardrailEscalationEffort, null);

  const absent = parseFocusManifest({ gate: { claMode: "advisory" } });
  assert.equal(absent.gate.aiReviewEffort, null);
  assert.equal(absent.gate.aiReviewSelfConsistencyRuns, null);
  assert.equal(absent.gate.guardrailEscalationProvider, null);
  assert.equal(absent.gate.guardrailEscalationModel, null);
  assert.equal(absent.gate.guardrailEscalationEffort, null);
  assert.equal(absent.gate.guardrailEscalationSelfConsistencyRuns, null);
  // Absent ⇒ the serializer emits no escalation block at all (not an empty one).
  const json = gateConfigToJson(absent.gate) as Record<string, unknown>;
  assert.equal(json.guardrailEscalation, undefined);
});
