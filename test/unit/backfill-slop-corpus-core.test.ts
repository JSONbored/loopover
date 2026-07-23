import { describe, expect, it } from "vitest";
import {
  parseDiffChangedFiles,
  renderSlopReplayReport,
  replaySlopCorpus,
  SLOP_BACKFILL_PROVENANCE,
  SLOP_BACKFILL_RULE_ID,
  type SlopReplaySourceCase,
} from "../../scripts/backfill-slop-corpus-core.js";
import { manifestToSourceCases } from "../../scripts/backfill-slop-corpus.js";

// #8277: the replay backfill's pure core. The scorer itself is the engine's own (its suite); these tests
// pin the diff parse, the signal-subset replay discipline (undefined inputs SKIP), the synthesized event
// shapes, and the skip/histogram accounting.

const SUBSTANTIVE_DIFF = [
  "diff --git a/src/thing.ts b/src/thing.ts",
  "--- a/src/thing.ts",
  "+++ b/src/thing.ts",
  "@@ -1,3 +1,6 @@",
  "+export function real(): number {",
  "+  return 42;",
  "+}",
  "-const old = 1;",
  "diff --git a/test/unit/thing.test.ts b/test/unit/thing.test.ts",
  "--- a/test/unit/thing.test.ts",
  "+++ b/test/unit/thing.test.ts",
  "@@ -0,0 +1,4 @@",
  "+import { real } from '../../src/thing';",
  "+it('answers', () => {",
  "+  expect(real()).toBe(42);",
  "+});",
].join("\n");

function sourceCase(over: Partial<SlopReplaySourceCase> = {}): SlopReplaySourceCase {
  return {
    targetKey: "acme/widgets#7",
    label: "confirmed",
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    diff: SUBSTANTIVE_DIFF,
    ...over,
  };
}

describe("parseDiffChangedFiles (#8277)", () => {
  it("yields one entry per diff --git block with +/- body counts, never counting the +++/--- headers", () => {
    const files = parseDiffChangedFiles(SUBSTANTIVE_DIFF);
    expect(files).toEqual([
      { path: "src/thing.ts", additions: 3, deletions: 1 },
      { path: "test/unit/thing.test.ts", additions: 4, deletions: 0 },
    ]);
  });

  it("never throws on junk: preamble-only text yields no files; a truncated tail just counts fewer lines", () => {
    expect(parseDiffChangedFiles("no diff here at all")).toEqual([]);
    expect(parseDiffChangedFiles("")).toEqual([]);
    const truncated = `${SUBSTANTIVE_DIFF}\n… [diff truncated at 45KB for the audit row]`;
    expect(parseDiffChangedFiles(truncated)).toHaveLength(2);
  });
});

describe("replaySlopCorpus (#8277)", () => {
  it("synthesizes a provenance-tagged fired/override pair with the replayed risk as confidence", () => {
    const report = replaySlopCorpus([sourceCase()]);
    expect(report.replayed).toBe(1);
    expect(report.rows).toHaveLength(2);
    const [fired, override] = report.rows;
    expect(fired!.id).toBe(`backfill:${SLOP_BACKFILL_RULE_ID}:acme/widgets#7:fired`);
    expect(fired!.eventType).toBe(`signal.rule_fired:${SLOP_BACKFILL_RULE_ID}`);
    const metadata = JSON.parse(fired!.metadataJson) as { confidence: number; provenance: string; computedSignals: string[]; band: string };
    expect(metadata.provenance).toBe(SLOP_BACKFILL_PROVENANCE);
    expect(metadata.confidence).toBeGreaterThanOrEqual(0);
    expect(metadata.confidence).toBeLessThanOrEqual(1);
    expect(Array.isArray(metadata.computedSignals)).toBe(true);
    expect(override!.eventType).toBe(`signal.human_override:${SLOP_BACKFILL_RULE_ID}`);
    expect(JSON.parse(override!.metadataJson)).toMatchObject({ verdict: "confirmed", provenance: SLOP_BACKFILL_PROVENANCE });
    expect(override!.createdAt).toBe("2026-06-02T00:00:00.000Z"); // decidedAt honored when after firedAt
  });

  it("signal-subset honesty: a substantive diff with tests fires NOTHING from the unarchived inputs (undefined skips, never inflates)", () => {
    const report = replaySlopCorpus([sourceCase()]);
    const metadata = JSON.parse(report.rows[0]!.metadataJson) as { confidence: number; computedSignals: string[] };
    // description/commits/cluster/linked-issue are all unarchived — none of their codes may appear.
    expect(metadata.computedSignals.join(",")).not.toMatch(/description|commit|duplicate|linked/i);
    expect(metadata.confidence).toBe(0); // substantive change + real test file: the diff-derivable signals are clean
    expect(report.riskCounts.zero).toBe(1);
  });

  it("counts skips honestly and de-duplicates targets (first case wins)", () => {
    const report = replaySlopCorpus([
      sourceCase(),
      sourceCase({ label: "reversed" }), // duplicate targetKey
      sourceCase({ targetKey: "acme/widgets#8", diff: "   " }),
      sourceCase({ targetKey: "acme/widgets#9", diff: "prose without any diff blocks" }),
    ]);
    expect(report.replayed).toBe(1);
    expect(report.skippedDuplicateTarget).toBe(1);
    expect(report.skippedEmptyDiff).toBe(1);
    expect(report.skippedNoFiles).toBe(1);
    expect(report.reversed).toBe(0); // the duplicate's label never counted
  });

  it("floors a non-increasing decidedAt to 1s after the firing so the corpus pairing always matches; bands histogram fills", () => {
    const whitespaceChurn = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      ...Array.from({ length: 30 }, () => "+       "),
      ...Array.from({ length: 30 }, () => "-\t"),
    ].join("\n");
    const report = replaySlopCorpus([
      sourceCase({ targetKey: "acme/widgets#10", diff: whitespaceChurn, decidedAt: "2026-05-01T00:00:00.000Z", label: "reversed" }),
    ]);
    expect(report.rows[1]!.createdAt).toBe("2026-06-01T00:00:01.000Z"); // floored past firedAt
    expect(report.riskCounts.zero + report.riskCounts.low + report.riskCounts.elevated + report.riskCounts.high).toBe(1);
    const metadata = JSON.parse(report.rows[0]!.metadataJson) as { confidence: number };
    expect(metadata.confidence).toBeGreaterThan(0); // churn-only diff scores above zero
    expect(report.reversed).toBe(1);
  });

  it("manifestToSourceCases projects manifest cases; a missing/non-string diff degrades to empty (counted, not thrown)", () => {
    const cases = manifestToSourceCases([
      { ruleId: "r", targetKey: "a/b#1", outcome: "close", label: "confirmed", firedAt: "f", decidedAt: "d", metadata: { diff: SUBSTANTIVE_DIFF } },
      { ruleId: "r", targetKey: "a/b#2", outcome: "close", label: "reversed", firedAt: "f", decidedAt: "d", metadata: { diff: 42 } },
      { ruleId: "r", targetKey: "a/b#3", outcome: "close", label: "reversed", firedAt: "f", decidedAt: "d" },
    ]);
    expect(cases.map((c) => c.diff === "")).toEqual([false, true, true]);
    const report = replaySlopCorpus(cases);
    expect(report.replayed).toBe(1);
    expect(report.skippedEmptyDiff).toBe(2);
  });

  it("renders both report modes with the provenance line", () => {
    const report = replaySlopCorpus([sourceCase()]);
    expect(renderSlopReplayReport(report, "dry-run")).toContain("dry-run only");
    expect(renderSlopReplayReport(report, "apply")).toContain("rows written: 2");
    expect(renderSlopReplayReport(report, "apply")).toContain(SLOP_BACKFILL_PROVENANCE);
  });
});
