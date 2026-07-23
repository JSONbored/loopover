import { describe, expect, it } from "vitest";
import { splitBacktestCorpus, type BacktestCase } from "@loopover/engine";
import { evaluateKnobDrift, evaluateKnobLoosening, LOOSENABLE_KNOBS, type LoosenableKnob } from "../../src/services/loosening-knobs";
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
import { buildKnobReliabilityRecs, buildReportOnlyKnobRecs } from "../../src/review/loosening-recs";

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

describe("buildKnobReliabilityRecs (#8227)", () => {
  const status = (over: Partial<{ knobId: string; liveValue: number; reliability: { suggestion: number | null } | null }> = {}) => ({
    knobId: "ai_review_close_confidence",
    liveValue: 0.93,
    reliability: { suggestion: 0.9 },
    ...over,
  });

  it("emits one info rec per live knob whose derived suggestion differs from live — and nothing otherwise", () => {
    const recs = buildKnobReliabilityRecs([
      status(), // differs -> rec
      status({ knobId: "satisfaction_floor", liveValue: 0.5, reliability: { suggestion: 0.5 } }), // equal -> silent
      status({ knobId: "third", reliability: { suggestion: null } }), // no suggestion -> silent
      status({ knobId: "fourth", reliability: null }), // no curve -> silent
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.project).toBe("global:ai_review_close_confidence");
    expect(recs[0]!.severity).toBe("info");
    expect(recs[0]!.message).toContain("0.9");
    expect(recs[0]!.message).toContain("SURFACING ONLY");
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

// ── #8212: config-drift evaluation — does ANY alternative Pareto-dominate the live value? ───────────────────

describe("evaluateKnobDrift on the close-confidence knob (#8212)", () => {
  function tighterFriendlyCorpus(): BacktestCase[] {
    // Mid-band firings (0.87) a human REVERSED: live 0.85 classifies them confirmed (missed reversals --
    // false negatives), the tighter 0.9 catches them (true positives) -- recall improves, precision holds.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.87, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.87, "reversed"));
    // Deep-low reversed anchors keep a true positive on both sides of every comparison.
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    return cases;
  }

  it("reports a LOOSER dominating alternative from the shipped live value (duplicates the loosening signal)", () => {
    const report = evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(report).not.toBeNull();
    expect(report!.knobId).toBe("ai_review_close_confidence");
    expect(report!.liveValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(report!.dominatingValue).toBe(0.9);
    expect(report!.direction).toBe("looser");
    expect(report!.visible.verdict).toBe("improved");
    expect(report!.heldOut.verdict).not.toBe("regressed");
    expect(report!.visibleCases).toBeGreaterThanOrEqual(AI_KNOB.minVisibleCases);
    expect(report!.heldOutCases).toBeGreaterThanOrEqual(AI_KNOB.minHeldOutCases);
  });

  it("reports a TIGHTER (non-shipped) dominating alternative from a loosened live value — the stale-config signal", () => {
    const report = evaluateKnobDrift(AI_KNOB, tighterFriendlyCorpus(), 0.85);
    expect(report).not.toBeNull();
    expect(report!.liveValue).toBe(0.85);
    expect(report!.dominatingValue).toBe(0.9); // nearest-to-live dominating alternative, not the farthest
    expect(report!.direction).toBe("tighter");
    expect(report!.visible.verdict).toBe("improved");
  });

  it("labels a dominating alternative that IS the shipped value as direction 'shipped' (revert-the-override signal)", () => {
    // Same mid-band-reversed shape, but at 0.91 so ONLY the shipped 0.93 catches them: live 0.9 and the
    // other candidate 0.85 both miss (0.91 >= both), so the nearest dominating alternative is shipped.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    const report = evaluateKnobDrift(AI_KNOB, cases, 0.9);
    expect(report).not.toBeNull();
    expect(report!.dominatingValue).toBe(AI_KNOB.shippedValue);
    expect(report!.direction).toBe("shipped");
  });

  it("returns null when nothing strictly dominates the live value (uniform corpus, all comparisons unchanged)", () => {
    // Every case sits far below every threshold with a reversed label: all values classify identically.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.5, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.5, "reversed"));
    expect(evaluateKnobDrift(AI_KNOB, cases)).toBeNull();
  });

  it("returns null on a sample below the knob's floors — never a drift call on noise", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.91, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.91, "confirmed")),
    ];
    expect(evaluateKnobDrift(AI_KNOB, thin)).toBeNull();
  });

  it("returns null when the visible split improves but the held-out split regresses (Pareto floor holds)", () => {
    // Visible: 0.91-confirmed mass (0.9 improves precision over live 0.93). Held-out: 0.91-REVERSED mass
    // (0.9 stops catching them -- recall regresses), so every looser alternative fails the held-out floor
    // and no tighter alternative exists above shipped.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "confirmed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    expect(evaluateKnobDrift(AI_KNOB, cases)).toBeNull();
  });

  it("breaks an equidistant tie toward the tighter value and never considers a sub-hard-minimum candidate", () => {
    // Custom knob: live 0.875 sits exactly between candidates 0.9 and 0.85 (tie -> tighter 0.9 tried first),
    // and the 0.2 candidate below the 0.3 hard minimum must be filtered before evaluation entirely.
    const tieKnob: LoosenableKnob = {
      ...AI_KNOB,
      knobId: "tie_probe",
      candidates: [0.9, 0.85, 0.2],
      hardMinimum: 0.3,
    };
    const cases: BacktestCase[] = [];
    // 0.88-confidence REVERSED mass: live 0.875 misses them (false negatives), tighter 0.9 catches them.
    for (const key of visibleKeys.slice(0, tieKnob.minVisibleCases + 6)) cases.push(aiCase(key, 0.88, "reversed"));
    for (const key of heldOutKeys.slice(0, tieKnob.minHeldOutCases + 3)) cases.push(aiCase(key, 0.88, "reversed"));
    cases.push(aiCase(visibleKeys[tieKnob.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[tieKnob.minHeldOutCases + 6]!, 0.5, "reversed"));

    const report = evaluateKnobDrift(tieKnob, cases, 0.875);
    expect(report).not.toBeNull();
    expect(report!.dominatingValue).toBe(0.9); // the equidistant tie prefers the tighter alternative
    expect(report!.direction).toBe("tighter");
  });

  it("is deterministic: the same corpus and live value always produce the same report", () => {
    expect(JSON.stringify(evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus()))).toBe(
      JSON.stringify(evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus())),
    );
  });
});
