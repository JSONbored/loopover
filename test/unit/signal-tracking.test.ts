// Root-level vitest coverage twin for `packages/loopover-engine/src/calibration/signal-tracking.ts` (#7982).
//
// The engine package already has a full, passing `node --test` suite at
// `packages/loopover-engine/test/signal-tracking.test.ts`, but that runner is NOT part of the root vitest run
// Codecov reads `codecov/patch` from — so `computeRulePrecision`/`computeRuleRepeatCount`/
// `evaluateRuleRepeatAlarm` report as ~0% covered despite being genuinely tested (#8343, same blind spot as
// #6250). This file re-exercises the same behavior through the engine barrel so vitest (and therefore Codecov)
// sees it too, exactly like the sibling twins `test/unit/calibration-dashboard.test.ts` and
// `test/unit/discovery-soft-claim.test.ts`. It intentionally mirrors every scenario in the package's own suite
// and covers both arms of every branch in the three functions.
import { describe, expect, it } from "vitest";
import {
  computeRulePrecision,
  computeRuleRepeatCount,
  evaluateRuleRepeatAlarm,
} from "../../packages/loopover-engine/src/index";
import type { HumanOverrideEvent, RuleFiredEvent } from "../../packages/loopover-engine/src/index";

function fired(ruleId: string, targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

describe("barrel: signal-tracking primitives are re-exported from the engine entrypoint (#7982/#7983)", () => {
  it("exposes the three primitives as functions", () => {
    expect(typeof computeRulePrecision).toBe("function");
    expect(typeof computeRuleRepeatCount).toBe("function");
    expect(typeof evaluateRuleRepeatAlarm).toBe("function");
  });
});

describe("computeRulePrecision", () => {
  it("no overrides -> decided is 0 and precision is null (unknown stays unknown, never coerced)", () => {
    const report = computeRulePrecision(
      "missing_linked_issue",
      [fired("missing_linked_issue", "a#1"), fired("missing_linked_issue", "a#2")],
      [],
    );
    expect(report).toEqual({
      ruleId: "missing_linked_issue",
      fired: 2,
      reversed: 0,
      confirmed: 0,
      decided: 0,
      precision: null,
    });
  });

  it("mixes confirmed and reversed verdicts into a real precision (decided > 0 arm)", () => {
    const report = computeRulePrecision(
      "missing_linked_issue",
      [
        fired("missing_linked_issue", "a#1"),
        fired("missing_linked_issue", "a#2"),
        fired("missing_linked_issue", "a#3"),
      ],
      [
        override("missing_linked_issue", "a#1", "confirmed"),
        override("missing_linked_issue", "a#2", "confirmed"),
        override("missing_linked_issue", "a#3", "reversed"),
      ],
    );
    expect(report.fired).toBe(3);
    expect(report.confirmed).toBe(2);
    expect(report.reversed).toBe(1);
    expect(report.decided).toBe(3);
    expect(report.precision).toBe(2 / 3);
  });

  it("100% reversed yields precision 0, not null (a real, scored bad outcome, not an unknown one)", () => {
    const report = computeRulePrecision("bad_rule", [fired("bad_rule", "a#1")], [override("bad_rule", "a#1", "reversed")]);
    expect(report.decided).toBe(1);
    expect(report.precision).toBe(0);
  });

  it("ignores fired/override events for a DIFFERENT ruleId entirely (both operand branches)", () => {
    const report = computeRulePrecision(
      "rule_a",
      [fired("rule_a", "a#1"), fired("rule_b", "a#2")],
      [override("rule_a", "a#1", "confirmed"), override("rule_b", "a#2", "reversed")],
    );
    expect(report.fired).toBe(1);
    expect(report.confirmed).toBe(1);
    expect(report.reversed).toBe(0);
  });

  it("an override with no matching fired event still counts toward decided (no cross-validation between the two lists)", () => {
    const report = computeRulePrecision("rule_a", [], [override("rule_a", "a#1", "confirmed")]);
    expect(report.fired).toBe(0);
    expect(report.decided).toBe(1);
    expect(report.precision).toBe(1);
  });
});

describe("computeRuleRepeatCount", () => {
  it("counts only fires matching BOTH ruleId and targetKey (each && operand's false arm exercised)", () => {
    const events = [
      fired("rule_a", "a#1"),
      fired("rule_a", "a#1"),
      fired("rule_a", "a#2"), // same rule, different target -> targetKey operand false
      fired("rule_b", "a#1"), // different rule, same target -> ruleId operand false
    ];
    expect(computeRuleRepeatCount("rule_a", "a#1", events)).toBe(2);
    expect(computeRuleRepeatCount("rule_a", "a#2", events)).toBe(1);
    expect(computeRuleRepeatCount("rule_b", "a#1", events)).toBe(1);
    expect(computeRuleRepeatCount("rule_a", "a#3", events)).toBe(0);
  });

  it("zero fired events yields 0, not an error", () => {
    expect(computeRuleRepeatCount("rule_a", "a#1", [])).toBe(0);
  });
});

describe("evaluateRuleRepeatAlarm (#7983)", () => {
  it("not triggered below the threshold", () => {
    const verdict = evaluateRuleRepeatAlarm("rule_a", [fired("rule_a", "a#1"), fired("rule_a", "a#2")], 3);
    expect(verdict.triggered).toBe(false);
    expect(verdict.affectedTargets).toEqual(["a#1", "a#2"]);
    expect(verdict.threshold).toBe(3);
  });

  it("triggers once distinct targets reach the threshold (boundary: exactly `threshold` distinct targets)", () => {
    const verdict = evaluateRuleRepeatAlarm(
      "rule_a",
      [fired("rule_a", "a#1"), fired("rule_a", "a#2"), fired("rule_a", "a#3")],
      3,
    );
    expect(verdict.triggered).toBe(true);
    expect(verdict.affectedTargets).toEqual(["a#1", "a#2", "a#3"]);
  });

  it("the SAME target firing repeatedly counts once, deduplicated in first-seen order (seen.has arm)", () => {
    const verdict = evaluateRuleRepeatAlarm(
      "rule_a",
      [fired("rule_a", "a#1"), fired("rule_a", "a#1"), fired("rule_a", "a#1")],
      2,
    );
    expect(verdict.affectedTargets).toEqual(["a#1"]);
    expect(verdict.triggered).toBe(false);
  });

  it("ignores fired events for a DIFFERENT ruleId entirely (ruleId mismatch arm)", () => {
    const verdict = evaluateRuleRepeatAlarm(
      "rule_a",
      [fired("rule_a", "a#1"), fired("rule_b", "a#2"), fired("rule_b", "a#3")],
      2,
    );
    expect(verdict.affectedTargets).toEqual(["a#1"]);
    expect(verdict.triggered).toBe(false);
  });

  it("zero fired events never triggers", () => {
    const verdict = evaluateRuleRepeatAlarm("rule_a", [], 1);
    expect(verdict.triggered).toBe(false);
    expect(verdict.affectedTargets).toEqual([]);
  });
});
