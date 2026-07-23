import { describe, expect, it } from "vitest";
import { splitBacktestCorpus, type BacktestCase } from "@loopover/engine";
import {
  evaluateSatisfactionFloorLoosening,
  SATISFACTION_FLOOR_HARD_MINIMUM,
  SATISFACTION_FLOOR_HELD_OUT_FRACTION,
  SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
  SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
  SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
  SATISFACTION_FLOOR_RULE_ID,
  SATISFACTION_FLOOR_SPLIT_SEED,
} from "../../src/services/satisfaction-floor-loosening";

// Fixture strategy: splitBacktestCorpus assigns held-out membership deterministically by
// (seed, ruleId, targetKey), so the test FIRST asks the real splitter which of a pool of keys land in
// which slice, THEN assigns each case's confidence/label per slice — no reimplementing the hash, no
// hoping a hardcoded key set splits a particular way.
function corpusCase(targetKey: string, confidence: number, label: "reversed" | "confirmed"): BacktestCase {
  return {
    ruleId: SATISFACTION_FLOOR_RULE_ID,
    targetKey,
    outcome: "unaddressed",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

function sliceMembership(keys: string[]): { visibleKeys: string[]; heldOutKeys: string[] } {
  const probe = keys.map((key) => corpusCase(key, 0.9, "confirmed"));
  const { visible, heldOut } = splitBacktestCorpus(probe, SATISFACTION_FLOOR_HELD_OUT_FRACTION, SATISFACTION_FLOOR_SPLIT_SEED);
  return { visibleKeys: visible.map((c) => c.targetKey), heldOutKeys: heldOut.map((c) => c.targetKey) };
}

const POOL = Array.from({ length: 120 }, (_, i) => `acme/widgets#${i + 1}`);
const { visibleKeys, heldOutKeys } = sliceMembership(POOL);

/** Build a corpus where every case in BOTH slices supports loosening 0.5 → 0.45: confidence 0.47 firings a
 *  human CONFIRMED (baseline floor 0.5 predicts them "reversed" — false positives; candidate 0.45 predicts
 *  "confirmed" — precision improves) plus anchor true-positives below every candidate so recall never moves. */
function looseningFriendlyCorpus(): BacktestCase[] {
  const cases: BacktestCase[] = [];
  for (const key of visibleKeys.slice(0, SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4)) {
    cases.push(corpusCase(key, 0.47, "confirmed"));
  }
  for (const key of heldOutKeys.slice(0, SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2)) {
    cases.push(corpusCase(key, 0.47, "confirmed"));
  }
  // One genuine reversed case per slice, far below every candidate, so precision/recall stay comparable.
  cases.push(corpusCase(visibleKeys[SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 5]!, 0.1, "reversed"));
  cases.push(corpusCase(heldOutKeys[SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 3]!, 0.1, "reversed"));
  return cases;
}

describe("evaluateSatisfactionFloorLoosening (#8121)", () => {
  it("proposes the SMALLEST loosening step when both splits support it, with full comparison evidence", () => {
    const proposal = evaluateSatisfactionFloorLoosening(looseningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedFloor).toBe(SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
    expect(proposal!.currentFloor).toBe(0.5);
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
    expect(proposal!.visibleCases).toBeGreaterThanOrEqual(SATISFACTION_FLOOR_MIN_VISIBLE_CASES);
    expect(proposal!.heldOutCases).toBeGreaterThanOrEqual(SATISFACTION_FLOOR_MIN_HELD_OUT_CASES);
    expect(proposal!.ruleId).toBe(SATISFACTION_FLOOR_RULE_ID);
  });

  it("is deterministic: identical corpus ⇒ identical proposal", () => {
    const corpus = looseningFriendlyCorpus();
    expect(evaluateSatisfactionFloorLoosening(corpus)).toEqual(evaluateSatisfactionFloorLoosening(corpus));
  });

  it("returns null on a too-small visible slice and on a too-small held-out slice — never loosens on noise", () => {
    const visibleOnly = visibleKeys.slice(0, SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((key) => corpusCase(key, 0.47, "confirmed"));
    expect(evaluateSatisfactionFloorLoosening(visibleOnly)).toBeNull(); // held-out side empty
    const heldOutOnly = heldOutKeys.slice(0, SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((key) => corpusCase(key, 0.47, "confirmed"));
    expect(evaluateSatisfactionFloorLoosening(heldOutOnly)).toBeNull(); // visible side too small
    expect(evaluateSatisfactionFloorLoosening([])).toBeNull();
  });

  it("returns null when no candidate improves the visible split (loosening would republish reversed calls)", () => {
    // Every borderline firing was REVERSED by a human: baseline (0.5) correctly predicts them reversed
    // (true positives); every candidate turns them into false negatives — recall regresses, nothing passes.
    const cases: BacktestCase[] = [
      ...visibleKeys.slice(0, SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((key) => corpusCase(key, 0.47, "reversed")),
      ...heldOutKeys.slice(0, SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((key) => corpusCase(key, 0.47, "reversed")),
    ];
    expect(evaluateSatisfactionFloorLoosening(cases)).toBeNull();
  });

  it("rejects a candidate the HELD-OUT split regresses on, even when the visible split improves", () => {
    // Visible slice: confirmed borderline firings (loosening improves precision). Held-out slice: REVERSED
    // borderline firings (loosening loses real catches — recall regresses). The overfitting guard must veto.
    const cases: BacktestCase[] = [
      ...visibleKeys.slice(0, SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((key) => corpusCase(key, 0.47, "confirmed")),
      corpusCase(visibleKeys[SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 5]!, 0.1, "reversed"),
      ...heldOutKeys.slice(0, SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((key) => corpusCase(key, 0.47, "reversed")),
    ];
    expect(evaluateSatisfactionFloorLoosening(cases)).toBeNull();
  });

  it("never proposes below the hard minimum, and never 'loosens' upward from an already-loosened floor", () => {
    // currentFloor already at the hard minimum: every candidate is >= currentFloor or < hard minimum.
    expect(evaluateSatisfactionFloorLoosening(looseningFriendlyCorpus(), SATISFACTION_FLOOR_HARD_MINIMUM)).toBeNull();
    // currentFloor between candidates (0.4): candidates 0.45 (>= current, skipped), 0.35/0.3 evaluated only.
    const corpus35: BacktestCase[] = [
      ...visibleKeys.slice(0, SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((key) => corpusCase(key, 0.37, "confirmed")),
      ...heldOutKeys.slice(0, SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((key) => corpusCase(key, 0.37, "confirmed")),
      corpusCase(visibleKeys[SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 5]!, 0.1, "reversed"),
      corpusCase(heldOutKeys[SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 3]!, 0.1, "reversed"),
    ];
    const proposal = evaluateSatisfactionFloorLoosening(corpus35, 0.4);
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedFloor).toBe(0.35);
    expect(proposal!.currentFloor).toBe(0.4);
    expect(proposal!.proposedFloor).toBeGreaterThanOrEqual(SATISFACTION_FLOOR_HARD_MINIMUM);
  });
});
