import { describe, expect, it } from "vitest";

// Engine SOURCE import (not dist) -- coverage.include lists packages/loopover-engine/src/**, so only a
// source-path import exercises these branches; the dist twin in packages/loopover-engine/test/ covers the
// built barrel for the workspace suite. Same pattern as backtest-compare-engine.test.ts.
import {
  AMS_MIN_RANK_MIN_HELD_OUT_CASES,
  AMS_MIN_RANK_MIN_VISIBLE_CASES,
  AMS_MIN_RANK_RULE_ID,
  AMS_MIN_RANK_SPLIT_SEED,
  buildAmsRankCorpus,
  runAmsMinRankBacktest,
  type AmsTakenOpportunity,
} from "../../packages/loopover-engine/src/calibration/ams-rank-corpus";

function take(issueNumber: number, rankScore: number, realizedDecision: "merged" | "closed"): AmsTakenOpportunity {
  return {
    repoFullName: "acme/widgets",
    issueNumber,
    rankScore,
    realizedDecision,
    discoveredAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
  };
}

// Uniform corpus: 60 closed takes at rank 0.15 (a 0.2 floor would have skipped exactly the bad takes) plus
// two merged anchors at 0.4 that stay above any candidate here. Deterministic: the split hashes fixed keys.
function skipFriendlyTakes(): AmsTakenOpportunity[] {
  const takes = Array.from({ length: 60 }, (_, i) => take(i + 1, 0.15, "closed"));
  takes.push(take(101, 0.4, "merged"), take(102, 0.4, "merged"));
  return takes;
}

describe("buildAmsRankCorpus (#8184)", () => {
  it("maps takes to cases with the skip polarity: closed -> reversed, merged -> confirmed, rank as confidence", () => {
    const cases = buildAmsRankCorpus([take(7, 0.3, "closed"), take(8, 0.9, "merged")]);
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      ruleId: AMS_MIN_RANK_RULE_ID,
      targetKey: "acme/widgets#issue-7",
      label: "reversed",
      metadata: { confidence: 0.3 },
    });
    expect(cases[1]).toMatchObject({ targetKey: "acme/widgets#issue-8", label: "confirmed", metadata: { confidence: 0.9 } });
  });

  it("drops non-replayable rank scores -- a case the classifier cannot honestly replay never defaults to confidence 1", () => {
    expect(buildAmsRankCorpus([take(1, Number.NaN, "closed"), take(2, -0.1, "merged"), take(3, 1.5, "closed")])).toEqual([]);
    // Boundary values ARE replayable.
    expect(buildAmsRankCorpus([take(4, 0, "closed"), take(5, 1, "merged")])).toHaveLength(2);
  });

  it("orders deterministically by target key then discoveredAt", () => {
    const shuffled = [take(20, 0.5, "merged"), take(3, 0.5, "closed"), take(11, 0.5, "merged")];
    const keys = buildAmsRankCorpus(shuffled).map((c) => c.targetKey);
    expect(keys).toEqual([...keys].sort());
    // Same key, different firedAt: earlier discovery sorts first.
    const twice = buildAmsRankCorpus([
      { ...take(9, 0.5, "closed"), discoveredAt: "2026-07-05T00:00:00.000Z" },
      { ...take(9, 0.5, "closed"), discoveredAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(twice.map((c) => c.firedAt)).toEqual(["2026-07-01T00:00:00.000Z", "2026-07-05T00:00:00.000Z"]);
  });
});

describe("runAmsMinRankBacktest (#8184)", () => {
  it("replays a candidate raise with the fixed-seed split and the symmetric Pareto floor on each slice", () => {
    const result = runAmsMinRankBacktest(buildAmsRankCorpus(skipFriendlyTakes()), 0, 0.2);
    expect(result).not.toBeNull();
    expect(result!.ruleId).toBe(AMS_MIN_RANK_RULE_ID);
    expect(result!.currentThreshold).toBe(0);
    expect(result!.candidateThreshold).toBe(0.2);
    expect(result!.visibleCases).toBeGreaterThanOrEqual(AMS_MIN_RANK_MIN_VISIBLE_CASES);
    expect(result!.heldOutCases).toBeGreaterThanOrEqual(AMS_MIN_RANK_MIN_HELD_OUT_CASES);
    // Raising 0 -> 0.2 catches every bad take (recall up) and skips no good one -- improved on both slices.
    expect(result!.visible.verdict).toBe("improved");
    expect(result!.heldOut.verdict).toBe("improved");
  });

  it("returns null -- never a guess -- when either slice misses its sample floor", () => {
    expect(runAmsMinRankBacktest(buildAmsRankCorpus(skipFriendlyTakes().slice(0, 5)), 0, 0.2)).toBeNull();
    expect(runAmsMinRankBacktest([], 0, 0.2)).toBeNull();
  });

  it("pins the split constants the miner replays under -- held-out membership must never reshuffle", () => {
    expect(AMS_MIN_RANK_SPLIT_SEED).toBe("ams-min-rank-skip-v1");
    expect(AMS_MIN_RANK_MIN_VISIBLE_CASES).toBe(20);
    expect(AMS_MIN_RANK_MIN_HELD_OUT_CASES).toBe(5);
  });
});
