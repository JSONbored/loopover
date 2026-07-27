import { describe, expect, it } from "vitest";
// Direct src-path import (not the `@loopover/engine` package barrel, which resolves to dist and is NOT in
// Codecov's measured set) — the engine-package blind-spot rule every engine mirror suite follows.
import {
  AMS_GATE_PREDICTION_RULE_ID,
  buildAmsPredictionCorpus,
  computeAmsCorpusStats,
  filterCasesByEngineVersion,
  type AmsPredictionRecord,
  type AmsRealizedOutcome,
} from "../../packages/loopover-engine/src/calibration/ams-prediction-corpus";
import { splitBacktestCorpus } from "../../packages/loopover-engine/src/calibration/backtest-split";

// #8183: the AMS corpus adapter. The load-bearing properties: the class mapping (agreement = confirmed,
// contradiction = reversed), the latest-per-head collapse, conservative skipping of everything
// directionless or malformed, and compatibility with the shared split primitive.

function prediction(over: Partial<AmsPredictionRecord> = {}): AmsPredictionRecord {
  return {
    repoFullName: "acme/widgets",
    targetId: 7,
    headSha: "head-1",
    conclusion: "merge",
    readinessScore: 82,
    engineVersion: "1.4.0",
    ts: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function outcome(over: Partial<AmsRealizedOutcome> = {}): AmsRealizedOutcome {
  return {
    repoFullName: "acme/widgets",
    prNumber: 7,
    decision: "merged",
    recordedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  };
}

describe("buildAmsPredictionCorpus (#8183)", () => {
  it("labels agreement confirmed and contradiction reversed — both directions", () => {
    const cases = buildAmsPredictionCorpus(
      [
        prediction(), // merge-pred, merged -> confirmed
        prediction({ targetId: 8, conclusion: "close", headSha: "head-8" }), // close-pred, closed -> confirmed
        prediction({ targetId: 9, conclusion: "merge", headSha: "head-9" }), // merge-pred, closed -> reversed
        prediction({ targetId: 10, conclusion: "close", headSha: "head-10" }), // close-pred, merged -> reversed
      ],
      [outcome(), outcome({ prNumber: 8, decision: "closed" }), outcome({ prNumber: 9, decision: "closed" }), outcome({ prNumber: 10, decision: "merged" })],
    );
    expect(cases.map((c) => [c.targetKey, c.outcome, c.label])).toEqual([
      ["acme/widgets#10", "close", "reversed"],
      ["acme/widgets#7", "merge", "confirmed"],
      ["acme/widgets#8", "close", "confirmed"],
      ["acme/widgets#9", "merge", "reversed"],
    ]);
    expect(cases.every((c) => c.ruleId === AMS_GATE_PREDICTION_RULE_ID)).toBe(true);
    expect(cases[1]!.metadata).toMatchObject({ engineVersion: "1.4.0", headSha: "head-1", confidence: 0.82 }); // 82/100 normalized
    expect(cases[1]!).toMatchObject({ firedAt: "2026-07-01T00:00:00.000Z", decidedAt: "2026-07-02T00:00:00.000Z" });
  });

  it("collapses re-predictions of the same head to the LATEST; different heads each stand as their own correctly-labeled case", () => {
    const cases = buildAmsPredictionCorpus(
      [
        prediction({ conclusion: "close", ts: "2026-07-01T00:00:00.000Z" }), // superseded re-prediction of head-1
        prediction({ conclusion: "merge", ts: "2026-07-01T06:00:00.000Z" }), // latest for head-1 -> confirmed vs merged
        prediction({ headSha: "head-2", conclusion: "close", ts: "2026-07-01T12:00:00.000Z" }), // other head -> reversed vs merged
      ],
      [outcome()],
    );
    expect(cases).toHaveLength(2);
    expect(cases.map((c) => [c.metadata?.headSha, c.outcome, c.label])).toEqual([
      ["head-1", "merge", "confirmed"],
      ["head-2", "close", "reversed"],
    ]);
  });

  it("orders deterministically through full ties: same PR, same timestamp, different heads (both comparator arms)", () => {
    const simultaneous = [
      prediction({ headSha: "head-b", ts: "2026-07-01T00:00:00.000Z" }),
      prediction({ headSha: "head-a", ts: "2026-07-01T00:00:00.000Z" }),
    ];
    const forward = buildAmsPredictionCorpus(simultaneous, [outcome()]);
    const reversedInput = buildAmsPredictionCorpus([...simultaneous].reverse(), [outcome()]);
    expect(forward.map((c) => c.metadata?.headSha)).toEqual(["head-a", "head-b"]);
    expect(reversedInput.map((c) => c.metadata?.headSha)).toEqual(["head-a", "head-b"]); // input order never leaks
  });

  it("skips everything conservative labeling demands: pending PRs, hold/unknown predictions, non-terminal outcomes, malformed rows", () => {
    const cases = buildAmsPredictionCorpus(
      [
        prediction({ targetId: 50 }), // no outcome at all -> pending
        prediction({ conclusion: "hold" }), // directionless
        prediction({ conclusion: "escalate" }), // unrecognized
        prediction({ repoFullName: "  " }), // malformed repo
        prediction({ targetId: 7.5 }), // non-integer target
        prediction({ ts: "not-a-date" }), // unparseable timestamp
      ],
      [
        outcome(),
        outcome({ prNumber: 51, decision: "reopened" }), // non-terminal decision
        outcome({ repoFullName: "" }), // malformed repo
        outcome({ prNumber: 52, recordedAt: "garbage" }), // unparseable timestamp
      ],
    );
    expect(cases).toEqual([]);
  });

  it("keeps null headSha and out-of-range/absent readiness out of metadata, and the corpus splits deterministically with the shared primitive", () => {
    const predictions = Array.from({ length: 40 }, (_, i) =>
      prediction({ targetId: i + 1, headSha: null, readinessScore: i % 3 === 0 ? null : i % 3 === 1 ? 170 : 50 }),
    );
    const outcomes = Array.from({ length: 40 }, (_, i) => outcome({ prNumber: i + 1 }));
    const cases = buildAmsPredictionCorpus(predictions, outcomes);
    expect(cases).toHaveLength(40);
    expect(cases.every((c) => !("headSha" in c.metadata!))).toBe(true);
    expect(cases.filter((c) => "confidence" in c.metadata!)).toHaveLength(13); // only the in-range third
    const { visible, heldOut } = splitBacktestCorpus(cases, 0.25, "ams-corpus-test-seed");
    expect(visible.length + heldOut.length).toBe(40);
    const again = splitBacktestCorpus(buildAmsPredictionCorpus(predictions, outcomes), 0.25, "ams-corpus-test-seed");
    expect(again.heldOut.map((c) => c.targetKey)).toEqual(heldOut.map((c) => c.targetKey)); // held-out membership stable
  });
});

describe("filterCasesByEngineVersion / computeAmsCorpusStats (#8183)", () => {
  it("filters to one engine build and aggregates numbers only", () => {
    const cases = buildAmsPredictionCorpus(
      [
        prediction(),
        prediction({ targetId: 9, headSha: "head-9", engineVersion: "1.5.0" }),
        prediction({ targetId: 10, headSha: "head-10", conclusion: "close", engineVersion: "1.5.0" }),
      ],
      [outcome(), outcome({ prNumber: 9, decision: "closed" }), outcome({ prNumber: 10, decision: "closed" })],
    );
    expect(filterCasesByEngineVersion(cases, "1.5.0").map((c) => c.targetKey)).toEqual(["acme/widgets#10", "acme/widgets#9"]);
    expect(filterCasesByEngineVersion(cases, "0.0.1")).toEqual([]);

    const stats = computeAmsCorpusStats(cases);
    expect(stats).toEqual({ cases: 3, confirmed: 2, reversed: 1, engineVersions: ["1.4.0", "1.5.0"] });
    expect(JSON.stringify(stats)).not.toMatch(/acme|head-|targetKey/); // aggregates only, no corpus content
  });

  it("handles the empty corpus and metadata-free cases (blank/missing engine version)", () => {
    expect(computeAmsCorpusStats([])).toEqual({ cases: 0, confirmed: 0, reversed: 0, engineVersions: [] });
    const blankVersion = buildAmsPredictionCorpus([prediction({ engineVersion: "" })], [outcome()]);
    expect(computeAmsCorpusStats(blankVersion).engineVersions).toEqual([]);
    expect(filterCasesByEngineVersion([{ ruleId: "x", targetKey: "a#1", outcome: "merge", label: "confirmed", firedAt: "t", decidedAt: "t" }], "1.0.0")).toEqual([]);
  });
});
