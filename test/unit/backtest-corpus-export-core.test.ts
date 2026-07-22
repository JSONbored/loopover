import { describe, expect, it } from "vitest";
import type { BacktestCase } from "@loopover/engine";
import { buildBacktestCorpusManifest, checksumCases } from "../../scripts/backtest-corpus-export-core.js";

function sampleCase(overrides: Partial<BacktestCase> = {}): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey: "owner/repo#1",
    outcome: "block",
    label: "confirmed",
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
    ...overrides,
  };
}

describe("backtest-corpus-export-core checksumCases (#8084)", () => {
  it("is stable for the same input regardless of key order within each case object", () => {
    const a: BacktestCase[] = [sampleCase({ outcome: "block", label: "confirmed" })];
    // Rebuild with a different enumeration order by spreading into a freshly keyed object.
    const b: BacktestCase[] = [
      {
        decidedAt: a[0]!.decidedAt,
        firedAt: a[0]!.firedAt,
        label: a[0]!.label,
        outcome: a[0]!.outcome,
        ruleId: a[0]!.ruleId,
        targetKey: a[0]!.targetKey,
      },
    ];
    expect(checksumCases(a)).toBe(checksumCases(b));
    expect(checksumCases(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when cases changes", () => {
    expect(checksumCases([sampleCase({ label: "confirmed" })])).not.toBe(checksumCases([sampleCase({ label: "reversed" })]));
    expect(checksumCases([sampleCase()])).not.toBe(checksumCases([sampleCase(), sampleCase({ targetKey: "owner/repo#2" })]));
  });
});

describe("backtest-corpus-export-core buildBacktestCorpusManifest (#8084)", () => {
  it("caseCount matches cases.length and an empty corpus produces a valid manifest with caseCount 0", () => {
    const empty = buildBacktestCorpusManifest("missing_linked_issue", []);
    expect(empty.ruleId).toBe("missing_linked_issue");
    expect(empty.caseCount).toBe(0);
    expect(empty.cases).toEqual([]);
    expect(empty.checksum).toBe(checksumCases([]));
    expect(empty.checksum).toMatch(/^[0-9a-f]{64}$/);

    const cases = [sampleCase(), sampleCase({ targetKey: "owner/repo#2", label: "reversed" })];
    const filled = buildBacktestCorpusManifest("missing_linked_issue", cases);
    expect(filled.caseCount).toBe(2);
    expect(filled.cases).toEqual(cases);
    expect(filled.checksum).toBe(checksumCases(cases));
  });

  it("spreads meta fields into the result without reading a clock", () => {
    const manifest = buildBacktestCorpusManifest("rule_a", [sampleCase({ ruleId: "rule_a" })], {
      generatedAt: "2026-07-22T12:00:00.000Z",
      source: "d1-local",
    });
    expect(manifest.generatedAt).toBe("2026-07-22T12:00:00.000Z");
    expect(manifest.source).toBe("d1-local");
    expect(manifest.ruleId).toBe("rule_a");
    expect(manifest.caseCount).toBe(1);
  });

  it("copies cases rather than retaining the caller's array reference", () => {
    const cases = [sampleCase()];
    const manifest = buildBacktestCorpusManifest("missing_linked_issue", cases);
    expect(manifest.cases).toEqual(cases);
    expect(manifest.cases).not.toBe(cases);
  });
});
