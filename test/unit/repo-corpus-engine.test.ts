import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / backtest-split-engine.test.ts.
import { computeRepoCorpusDensity, sliceCorpusByRepo } from "../../packages/loopover-engine/src/calibration/repo-corpus";
import { splitBacktestCorpus } from "../../packages/loopover-engine/src/calibration/backtest-split";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

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

describe("sliceCorpusByRepo (#8215)", () => {
  it("slices a multi-repo corpus by the last '#', preserving per-slice case order and first-appearance repo order", () => {
    const cases = [
      corpusCase("acme/widgets#1"),
      corpusCase("acme/gadgets#7"),
      corpusCase("acme/widgets#2", "reversed"),
      corpusCase("beta/tools#3"),
      corpusCase("acme/widgets#3"),
    ];
    const slices = sliceCorpusByRepo(cases);
    expect([...slices.keys()]).toEqual(["acme/widgets", "acme/gadgets", "beta/tools"]);
    expect(slices.get("acme/widgets")!.map((c) => c.targetKey)).toEqual(["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"]);
    expect(slices.get("acme/gadgets")).toHaveLength(1);
    expect(slices.get("beta/tools")).toHaveLength(1);
  });

  it("keys a repo containing an embedded '#' by the LAST '#', keeping the full repo name intact", () => {
    const slices = sliceCorpusByRepo([corpusCase("acme/wid#gets#12")]);
    expect([...slices.keys()]).toEqual(["acme/wid#gets"]);
  });

  it("drops unparseable target keys — no '#', or nothing before it — instead of guessing a slice", () => {
    const good = corpusCase("acme/widgets#1");
    const slices = sliceCorpusByRepo([corpusCase("no-hash-at-all"), corpusCase("#5"), good]);
    expect([...slices.keys()]).toEqual(["acme/widgets"]);
    expect(slices.get("acme/widgets")).toEqual([good]);
  });

  it("returns an empty map for an empty corpus", () => {
    expect(sliceCorpusByRepo([])).toEqual(new Map());
  });
});

describe("computeRepoCorpusDensity (#8215)", () => {
  const SEED = "repo-density-test-v1";
  const FRACTION = 0.25;

  // Probe the real splitter per candidate repo slice so eligibility fixtures are membership-exact rather
  // than luck-based — the same probing technique test/unit/loosening-knobs.test.ts uses.
  function denseRepoCases(repoFullName: string, count: number): BacktestCase[] {
    return Array.from({ length: count }, (_, i) => corpusCase(`${repoFullName}#${i + 1}`, i % 3 === 0 ? "reversed" : "confirmed"));
  }

  it("reports aggregate-only per-repo counts and applies the split-based eligibility floors to each repo's OWN slice", () => {
    const dense = denseRepoCases("acme/dense", 40);
    const sparse = denseRepoCases("acme/sparse", 3);
    const densities = computeRepoCorpusDensity([...dense, ...sparse], 5, 2, FRACTION, SEED);

    const denseSplit = splitBacktestCorpus(dense, FRACTION, SEED);
    expect(densities.get("acme/dense")).toEqual({
      cases: 40,
      confirmed: dense.filter((c) => c.label === "confirmed").length,
      reversed: dense.filter((c) => c.label === "reversed").length,
      eligible: denseSplit.visible.length >= 5 && denseSplit.heldOut.length >= 2,
    });
    expect(densities.get("acme/dense")!.eligible).toBe(true); // 40 cases at 0.25 clears 5/2 for this seed
    expect(densities.get("acme/sparse")!.eligible).toBe(false); // 3 cases can never clear the floors
    expect(densities.get("acme/sparse")!.cases).toBe(3);
  });

  it("marks a repo ineligible when its held-out side alone misses the floor, even with a large visible side", () => {
    const cases = denseRepoCases("acme/lopsided", 40);
    const { heldOut } = splitBacktestCorpus(cases, FRACTION, SEED);
    const densities = computeRepoCorpusDensity(cases, 1, heldOut.length + 1, FRACTION, SEED);
    expect(densities.get("acme/lopsided")!.eligible).toBe(false);
  });

  it("is deterministic per slice: identical corpus + parameters yield the identical map", () => {
    const cases = [...denseRepoCases("acme/a", 12), ...denseRepoCases("acme/b", 8)];
    expect(computeRepoCorpusDensity(cases, 3, 1, FRACTION, SEED)).toEqual(computeRepoCorpusDensity(cases, 3, 1, FRACTION, SEED));
  });

  it("never leaks target keys or metadata — aggregate numbers and the eligibility flag only", () => {
    const densities = computeRepoCorpusDensity(denseRepoCases("acme/private", 10), 2, 1, FRACTION, SEED);
    for (const [repo, density] of densities) {
      expect(repo).toBe("acme/private");
      expect(Object.keys(density).sort()).toEqual(["cases", "confirmed", "eligible", "reversed"]);
      expect(JSON.stringify(density)).not.toContain("#");
    }
  });
});
