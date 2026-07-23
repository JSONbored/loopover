import { describe, expect, it } from "vitest";
import { splitBacktestCorpus, type BacktestCase } from "@loopover/engine";
import { evaluateKnobLoosening, LOOSENABLE_KNOBS, type LoosenableKnob } from "../../src/services/loosening-knobs";
import {
  SATISFACTION_FLOOR_HARD_MINIMUM,
  SATISFACTION_FLOOR_HELD_OUT_FRACTION,
  SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
  SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
  SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
  SATISFACTION_FLOOR_RULE_ID,
  SATISFACTION_FLOOR_SPLIT_SEED,
} from "../../src/services/satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";
import { DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE } from "../../src/rules/advisory";
import { buildReportOnlyKnobRecs } from "../../src/review/loosening-recs";

const AI_KNOB = LOOSENABLE_KNOBS.ai_review_close_confidence!;

describe("LOOSENABLE_KNOBS registry invariants (#8159)", () => {
  it("pins the satisfaction knob to the #8121 narrow start's exact values and seed — behavior and held-out membership stay byte-stable", () => {
    expect(LOOSENABLE_KNOBS.satisfaction_floor).toEqual({
      knobId: "satisfaction_floor",
      ruleId: SATISFACTION_FLOOR_RULE_ID,
      shippedValue: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      candidates: SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
      hardMinimum: SATISFACTION_FLOOR_HARD_MINIMUM,
      minVisibleCases: SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
      minHeldOutCases: SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
      heldOutFraction: SATISFACTION_FLOOR_HELD_OUT_FRACTION,
      splitSeed: SATISFACTION_FLOOR_SPLIT_SEED,
      applyMode: "live",
      // #8176's apply plumbing — pinned to the legacy run module's constants by knob-loosening-run.test.ts.
      overrideFlagKey: "satisfaction_floor_override",
      looseningEventType: "calibration.satisfaction_floor_loosened",
      autotuneEnvVar: "SATISFACTION_FLOOR_AUTOTUNE_ENABLED",
    });
  });

  it("pins the close-confidence knob to the shipped default, tight bounds, and its LIVE apply plumbing (#8176)", () => {
    expect(AI_KNOB.shippedValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(AI_KNOB.ruleId).toBe("ai_consensus_defect");
    expect(AI_KNOB.applyMode).toBe("live"); // flipped by #8176 — the override consumer ships with it
    expect(AI_KNOB.hardMinimum).toBe(0.85);
    expect(AI_KNOB.overrideFlagKey).toBe("ai_review_close_confidence_override");
    expect(AI_KNOB.looseningEventType).toBe("calibration.ai_review_close_confidence_loosened");
    expect(AI_KNOB.autotuneEnvVar).toBe("AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED");
  });

  it("every entry satisfies the structural safety invariants: candidates strictly below shipped, at/above the hard minimum, descending; ids and seeds unique", () => {
    const knobs = Object.values(LOOSENABLE_KNOBS);
    for (const knob of knobs) {
      expect(knob.candidates.length).toBeGreaterThan(0);
      for (const candidate of knob.candidates) {
        expect(candidate).toBeLessThan(knob.shippedValue);
        expect(candidate).toBeGreaterThanOrEqual(knob.hardMinimum);
      }
      expect([...knob.candidates].sort((a, b) => b - a)).toEqual([...knob.candidates]); // nearest-first
      expect(knob.minVisibleCases).toBeGreaterThan(0);
      expect(knob.minHeldOutCases).toBeGreaterThan(0);
      expect(["live", "report_only"]).toContain(knob.applyMode);
    }
    expect(new Set(knobs.map((knob) => knob.knobId)).size).toBe(knobs.length);
    expect(new Set(knobs.map((knob) => knob.splitSeed)).size).toBe(knobs.length);
    for (const [key, knob] of Object.entries(LOOSENABLE_KNOBS)) expect(key).toBe(knob.knobId);
  });
});

// Fixture strategy mirrors the satisfaction suite: probe the real splitter for slice membership under THIS
// knob's seed/rule, then assign confidence/label per slice.
function aiCase(targetKey: string, confidence: number, label: "reversed" | "confirmed"): BacktestCase {
  return {
    ruleId: AI_KNOB.ruleId,
    targetKey,
    outcome: "close",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

const POOL = Array.from({ length: 400 }, (_, i) => `acme/widgets#${i + 1}`);
const probe = POOL.map((key) => aiCase(key, 0.99, "confirmed"));
const { visible, heldOut } = splitBacktestCorpus(probe, AI_KNOB.heldOutFraction, AI_KNOB.splitSeed);
const visibleKeys = visible.map((c) => c.targetKey);
const heldOutKeys = heldOut.map((c) => c.targetKey);

function aiLooseningFriendlyCorpus(): BacktestCase[] {
  const cases: BacktestCase[] = [];
  // Borderline firings a human CONFIRMED at confidence 0.91 (between candidate 0.9 and shipped 0.93):
  // baseline predicts them reversed (false positives); candidate 0.9 stops firing them — precision improves.
  for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "confirmed"));
  for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "confirmed"));
  // A deep-low reversed anchor per slice keeps a true positive on both sides of every comparison.
  cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
  cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
  return cases;
}

describe("evaluateKnobLoosening on the close-confidence knob (#8159)", () => {
  it("proposes the smallest candidate step with full evidence when both splits support it", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.knobId).toBe("ai_review_close_confidence");
    expect(proposal!.currentValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(proposal!.proposedValue).toBe(0.9);
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
  });

  it("never loosens on a sample below THIS knob's own (higher) floors", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.91, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.91, "confirmed")),
    ];
    expect(evaluateKnobLoosening(AI_KNOB, thin)).toBeNull();
  });

  it("refuses to step below the hard minimum even from an already-loosened current value", () => {
    expect(evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus(), AI_KNOB.hardMinimum)).toBeNull();
  });
});

describe("buildReportOnlyKnobRecs (#8159)", () => {
  it("surfaces the evidence with the report-only action line and NEVER a payload", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus())!;
    const recs = buildReportOnlyKnobRecs([proposal]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.project).toBe("global:ai_review_close_confidence");
    expect(recs[0]!.severity).toBe("good");
    expect(recs[0]!.message).toContain(`${DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE} → 0.9`);
    expect(recs[0]!.message).toContain("no override consumer yet");
    expect(recs[0]!.overridePayload).toBeUndefined();
    expect(buildReportOnlyKnobRecs([])).toEqual([]);
  });
});
