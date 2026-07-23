import assert from "node:assert/strict";
import { test } from "node:test";

import { AMS_MIN_RANK_RULE_ID, buildAmsRankCorpus, runAmsMinRankBacktest, type AmsTakenOpportunity } from "../dist/index.js";

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

test("barrel: the public entrypoint re-exports the AMS min-rank corpus + backtest (#8184)", () => {
  assert.equal(typeof buildAmsRankCorpus, "function");
  assert.equal(typeof runAmsMinRankBacktest, "function");
  assert.equal(AMS_MIN_RANK_RULE_ID, "ams_min_rank_skip");
});

test("runAmsMinRankBacktest: a raise that skips exactly the bad takes is improved on both slices", () => {
  const takes = Array.from({ length: 60 }, (_, i) => take(i + 1, 0.15, "closed"));
  takes.push(take(101, 0.4, "merged"), take(102, 0.4, "merged"));
  const result = runAmsMinRankBacktest(buildAmsRankCorpus(takes), 0, 0.2);
  assert.ok(result);
  assert.equal(result.visible.verdict, "improved");
  assert.equal(result.heldOut.verdict, "improved");
});
