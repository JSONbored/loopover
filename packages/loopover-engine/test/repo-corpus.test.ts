import assert from "node:assert/strict";
import { test } from "node:test";

import { computeRepoCorpusDensity, sliceCorpusByRepo, splitBacktestCorpus, type BacktestCase } from "../dist/index.js";

function corpusCase(targetKey: string, label: BacktestCase["label"] = "confirmed"): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
  };
}

test("barrel: the public entrypoint re-exports the per-repo corpus primitives (#8215)", () => {
  assert.equal(typeof sliceCorpusByRepo, "function");
  assert.equal(typeof computeRepoCorpusDensity, "function");
});

test("sliceCorpusByRepo: slices by the last '#', preserves order, drops unparseable keys", () => {
  const slices = sliceCorpusByRepo([
    corpusCase("acme/widgets#1"),
    corpusCase("beta/tools#3"),
    corpusCase("acme/widgets#2"),
    corpusCase("no-hash"),
    corpusCase("#5"),
  ]);
  assert.deepEqual([...slices.keys()], ["acme/widgets", "beta/tools"]);
  assert.deepEqual(
    slices.get("acme/widgets")!.map((c) => c.targetKey),
    ["acme/widgets#1", "acme/widgets#2"],
  );
});

test("computeRepoCorpusDensity: per-repo aggregates with the split-floor eligibility bar", () => {
  const dense = Array.from({ length: 40 }, (_, i) => corpusCase(`acme/dense#${i + 1}`, i % 2 === 0 ? "reversed" : "confirmed"));
  const sparse = [corpusCase("acme/sparse#1"), corpusCase("acme/sparse#2", "reversed")];
  const densities = computeRepoCorpusDensity([...dense, ...sparse], 5, 2, 0.25, "repo-density-test-v1");

  const denseDensity = densities.get("acme/dense")!;
  assert.equal(denseDensity.cases, 40);
  assert.equal(denseDensity.confirmed + denseDensity.reversed, 40);
  const denseSplit = splitBacktestCorpus(dense, 0.25, "repo-density-test-v1");
  assert.equal(denseDensity.eligible, denseSplit.visible.length >= 5 && denseSplit.heldOut.length >= 2);

  assert.deepEqual(densities.get("acme/sparse"), { cases: 2, confirmed: 1, reversed: 1, eligible: false });
});
