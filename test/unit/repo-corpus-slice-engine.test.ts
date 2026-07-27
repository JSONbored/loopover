import { describe, expect, it } from "vitest";
// Direct src-path import (not the `@loopover/engine` package barrel, which resolves to dist and is NOT in
// vitest's coverage.include): the engine's own node:test suite runs against dist and is invisible to Codecov,
// so this vitest mirror is what gives packages/loopover-engine/src/calibration/repo-corpus-slice.ts its
// codecov/patch coverage (the "engine blind-spot rule"). The companion
// packages/loopover-engine/test/repo-corpus-slice.test.ts is the node:test that gates the engine workspace's
// own `npm run test`. Vite resolves the `.js` specifier to the sibling `.ts` on disk.
import { computeRepoCorpusDensity, sliceCorpusByRepo } from "../../packages/loopover-engine/src/calibration/repo-corpus-slice";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

function bcase(targetKey: string, label: BacktestCase["label"] = "confirmed"): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label,
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
  };
}

describe("sliceCorpusByRepo (#8215)", () => {
  it("groups by owner/repo, preserving input order within each slice and first-seen key order", () => {
    const slices = sliceCorpusByRepo([bcase("acme/widgets#1"), bcase("acme/gadgets#5"), bcase("acme/widgets#2")]);
    expect([...slices.keys()]).toEqual(["acme/widgets", "acme/gadgets"]);
    expect(slices.get("acme/widgets")!.map((c) => c.targetKey)).toEqual(["acme/widgets#1", "acme/widgets#2"]);
    expect(slices.get("acme/gadgets")!.map((c) => c.targetKey)).toEqual(["acme/gadgets#5"]);
  });

  it("drops targetKeys with no '#' or an empty repo prefix, never guessing", () => {
    const slices = sliceCorpusByRepo([bcase("acme/widgets#1"), bcase("no-hash"), bcase("#123")]);
    expect([...slices.keys()]).toEqual(["acme/widgets"]);
    expect(slices.get("acme/widgets")!).toHaveLength(1);
  });

  it("parses the repo from the LAST '#' so an issue-fragment hash can't truncate it early", () => {
    expect([...sliceCorpusByRepo([bcase("acme/widgets#12#note")]).keys()]).toEqual(["acme/widgets#12"]);
  });
});

describe("computeRepoCorpusDensity (#8215)", () => {
  it("reports per-repo case counts and the confirmed/reversed label split", () => {
    const density = computeRepoCorpusDensity(
      [bcase("acme/widgets#1", "confirmed"), bcase("acme/widgets#2", "reversed"), bcase("acme/widgets#3", "confirmed")],
      0,
      0,
      0,
      "seed",
    );
    expect(density.get("acme/widgets")).toEqual({ cases: 3, confirmed: 2, reversed: 1, eligible: true });
  });

  it("eligible=true when a repo's own slice clears both floors after the split", () => {
    const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 2, 0, 0, "seed");
    expect(density.get("acme/widgets")!.eligible).toBe(true);
  });

  it("eligible=false when the visible floor is not met (left side of the &&)", () => {
    const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 5, 0, 0, "seed");
    expect(density.get("acme/widgets")!.eligible).toBe(false);
  });

  it("eligible=false when the held-out floor is not met (right side of the &&)", () => {
    const density = computeRepoCorpusDensity([bcase("acme/widgets#1"), bcase("acme/widgets#2")], 1, 1, 0, "seed");
    expect(density.get("acme/widgets")!.eligible).toBe(false);
  });

  it("a large global corpus cannot lend density to a sparse repo (own-slice floors)", () => {
    const cases = [...Array.from({ length: 8 }, (_unused, i) => bcase(`acme/big#${i}`)), bcase("acme/small#1")];
    const density = computeRepoCorpusDensity(cases, 3, 0, 0, "seed");
    expect(density.get("acme/big")!.eligible).toBe(true);
    expect(density.get("acme/small")!.eligible).toBe(false);
  });

  it("is deterministic — same corpus + params yields an equal report", () => {
    const cases = [bcase("acme/widgets#1", "confirmed"), bcase("acme/gadgets#2", "reversed")];
    expect([...computeRepoCorpusDensity(cases, 1, 0, 0.5, "seed").entries()]).toEqual(
      [...computeRepoCorpusDensity(cases, 1, 0, 0.5, "seed").entries()],
    );
  });

  it("an empty corpus yields an empty density map", () => {
    expect(computeRepoCorpusDensity([], 1, 1, 0.5, "seed").size).toBe(0);
  });
});
