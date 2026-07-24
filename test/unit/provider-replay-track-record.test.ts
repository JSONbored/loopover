import { describe, expect, it } from "vitest";
import type { BacktestCase } from "@loopover/engine";
import { computeProviderTrackRecords } from "@loopover/engine";
import { artifactKey, planReplay } from "../../scripts/counterfactual-replay-core.js";
import { artifactsToProviderSignals, renderProviderTable } from "../../scripts/provider-replay-track-record.js";

// #8278: the replay→signals adapter. computeProviderTrackRecords has its own engine suite; these tests pin
// the verdict→vote mapping, the abstention/uncached accounting, and the overall-rollup table rendering.

function corpusCase(id: number, label: "confirmed" | "reversed"): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey: `acme/widgets#${id}`,
    outcome: "close",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    metadata: { diff: "diff --git a/x b/x" },
  };
}

const SAMPLING = { seed: "counterfactual-replay-v1:test", maxFixtures: 100 };
const VARIANT = { promptVersion: "minimal-judge", modelSpec: "qwen3:8b" };

describe("artifactsToProviderSignals (#8278)", () => {
  it("maps would_flag→fail, would_not_flag→pass; abstentions and uncached fixtures yield NO signal, counted separately", () => {
    const cases = [corpusCase(1, "reversed"), corpusCase(2, "confirmed"), corpusCase(3, "confirmed"), corpusCase(4, "reversed")];
    const plan = planReplay(cases, SAMPLING);
    const byKey: Record<string, string> = {
      [artifactKey(VARIANT, "acme/widgets#1")]: '{"blockers": ["real"]}',
      [artifactKey(VARIANT, "acme/widgets#2")]: '{"blockers": []}',
      [artifactKey(VARIANT, "acme/widgets#3")]: "no json at all", // abstains
      // #4 uncached
    };
    const { signals, abstained, uncached } = artifactsToProviderSignals(plan, VARIANT, (key) => byKey[key] ?? null);
    expect(abstained).toBe(1);
    expect(uncached).toBe(1);
    expect(signals).toEqual([
      { provider: "qwen3:8b", repoFullName: "acme/widgets", targetKey: "acme/widgets#1", vote: "fail" },
      { provider: "qwen3:8b", repoFullName: "acme/widgets", targetKey: "acme/widgets#2", vote: "pass" },
    ]);
    // The adapter's output feeds the engine aggregation directly: one decided fail on a reversed label.
    const overall = computeProviderTrackRecords(signals, cases).find((record) => record.repoFullName === null)!;
    expect(overall.decided).toBe(2);
    expect(overall.precision).toBe(0); // the lone fail vote landed on a reversed... label "reversed" means the firing was wrong
  });

  it("renderProviderTable renders only the overall rollups with n/a for null rates", () => {
    const table = renderProviderTable([
      { provider: "a", repoFullName: null, signals: 2, decided: 2, confirmed: 1, reversed: 1, precision: 0.5, agreementRate: null, consensusRate: null, splitRate: null },
      { provider: "a", repoFullName: "acme/widgets", signals: 2, decided: 2, confirmed: 1, reversed: 1, precision: 0.5, agreementRate: 0.5, consensusRate: null, splitRate: null },
    ]);
    expect(table).toContain("| a | 2 | 2 | 0.500 | n/a | n/a |");
    expect(table.split("\n")).toHaveLength(3); // header + divider + ONE overall row (per-repo rows excluded)
  });
});
