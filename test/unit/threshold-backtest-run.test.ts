import { afterEach, describe, expect, it, vi } from "vitest";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import * as repositories from "../../src/db/repositories";
import { listAuditEventsByType } from "../../src/db/repositories";
import { persistThresholdBacktestRuns, runThresholdBacktestAdvisory, THRESHOLD_BACKTEST_EVENT_TYPE } from "../../src/services/threshold-backtest-run";
import { checksumCases } from "@loopover/engine";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.restoreAllMocks();
});

function diffFor(name: string, oldValue: string, newValue: string): string {
  return ["diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts", "@@ -980,7 +980,7 @@", `-export const ${name} = ${oldValue};`, `+export const ${name} = ${newValue};`].join("\n");
}

describe("runThresholdBacktestAdvisory (#8138) — real D1 round-trip", () => {
  it("returns empty changed/comparisons when the diff touches no known threshold, without any D1 read", async () => {
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, "diff --git a/README.md b/README.md\n-old\n+new");
    expect(result).toEqual({ changed: [], comparisons: [], corpusChecksumByRuleId: new Map() });
  });

  it("backtests a changed LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR against real recorded history", async () => {
    const env = createTestEnv();
    const now = Date.now();
    await createSignalStore(env).recordRuleFired({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#1",
      outcome: "unaddressed",
      occurredAt: new Date(now - 1000).toISOString(),
      metadata: { confidence: 0.35 },
    });
    await createSignalStore(env).recordHumanOverride({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#1",
      verdict: "reversed",
      occurredAt: new Date(now).toISOString(),
    });

    const result = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.2"), now + 1000);
    expect(result.changed).toHaveLength(1);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.ruleId).toBe("linked_issue_scope_mismatch");
    expect(result.comparisons[0]!.baseline.caseCount).toBe(1);
  });

  it("degrades to an empty corpus for a ruleId with no recorded history, rather than throwing", async () => {
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, diffFor("DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", "0.93", "0.8"));
    expect(result.comparisons).toHaveLength(2);
    for (const comparison of result.comparisons) {
      expect(comparison.baseline.caseCount).toBe(0);
      expect(comparison.baseline.precision).toBeNull();
    }
  });

  it("degrades to an empty corpus (never throws) when the SignalStore read itself rejects", async () => {
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      recordRuleFired: vi.fn(),
      recordHumanOverride: vi.fn(),
      queryRuleHistory: vi.fn().mockRejectedValue(new Error("simulated D1 failure")),
    });
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"));
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.baseline.caseCount).toBe(0);
    expect(result.comparisons[0]!.baseline.precision).toBeNull();
  });
});

describe("persistThresholdBacktestRuns (#8138) — real D1 round-trip", () => {
  it("records one audit_events row per (constant, ruleId) pair, readable back via listAuditEventsByType", async () => {
    const env = createTestEnv();
    const now = Date.now();
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 7, changed, comparisons);

    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetKey).toBe("acme/widgets#7");
    expect(rows[0]!.metadata.constantName).toBe("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR");
    expect((rows[0]!.metadata.comparison as { ruleId: string }).ruleId).toBe("linked_issue_scope_mismatch");
  });

  it("persists nothing when nothing changed", async () => {
    const env = createTestEnv();
    await persistThresholdBacktestRuns(env, "acme/widgets", 1, [], []);
    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(0).toISOString());
    expect(rows).toHaveLength(0);
  });

  it("skips a changed threshold with no matching comparison, rather than erroring (defensive guard for direct callers)", async () => {
    const env = createTestEnv();
    await persistThresholdBacktestRuns(
      env,
      "acme/widgets",
      1,
      [{ constantName: "LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", oldValue: 0.5, newValue: 0.4, ruleIds: ["linked_issue_scope_mismatch"] }],
      [], // no comparison for that ruleId
    );
    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(0).toISOString());
    expect(rows).toHaveLength(0);
  });

  it("degrades silently (never throws) when the recordAuditEvent write itself rejects", async () => {
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("simulated D1 write failure"));
    const env = createTestEnv();
    const now = Date.now();
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await expect(persistThresholdBacktestRuns(env, "acme/widgets", 8, changed, comparisons)).resolves.toBeUndefined();
  });
});

// #9639: loadPublicRulePrecision selects the latest backtest run with
// `json_extract(metadata_json, '$.corpusChecksum') IS NOT NULL`. This writer never emitted the field, so a
// deployment whose only backtest history is in-Worker had `latestBacktestRun: null` forever -- and
// buildEvalScoreRecordsFromRulePrecision early-returns [] on that, which is why /v1/public/eval-scores
// served zero records with no diagnostic.
describe("persistThresholdBacktestRuns writes the corpus freeze point (#9639)", () => {
  const seedHistory = async (env: Env, now: number) => {
    const store = createSignalStore(env);
    // A labeled case needs BOTH halves: the firing (with its confidence) and the human verdict that scores it.
    // Firings alone build an empty corpus, whose checksum is the rule-independent EMPTY_CORPUS_CHECKSUM.
    for (let i = 0; i < 4; i += 1) {
      await store.recordRuleFired({
        ruleId: "linked_issue_scope_mismatch",
        targetKey: `acme/widgets#${i + 1}`,
        outcome: "unaddressed",
        occurredAt: new Date(now - (i + 2) * 1000).toISOString(),
        metadata: { confidence: 0.3 + i * 0.2 },
      });
      await store.recordHumanOverride({
        ruleId: "linked_issue_scope_mismatch",
        targetKey: `acme/widgets#${i + 1}`,
        verdict: i % 2 === 0 ? "reversed" : "confirmed",
        occurredAt: new Date(now - (i + 1) * 1000).toISOString(),
      });
    }
  };

  it("REGRESSION: writes metadata.corpusChecksum, the field the public reader filters on", async () => {
    const env = createTestEnv();
    const now = Date.now();
    await seedHistory(env, now);
    const { changed, comparisons, corpusChecksumByRuleId } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 7, changed, comparisons, corpusChecksumByRuleId);

    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString());
    expect(rows).toHaveLength(1);
    const checksum = rows[0]!.metadata.corpusChecksum;
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    // Not the rule-independent empty-corpus digest -- that would commit to nothing re-derivable.
    expect(checksum).not.toBe(checksumCases([]));
    // Not just "a hash": the SAME hash the shared freeze-point function produces over the scored corpus.
    expect(checksum).toBe(corpusChecksumByRuleId.get("linked_issue_scope_mismatch"));
  });

  it("leaves metadata.comparison and metadata.constantName untouched -- rule-calibration-trend.ts reads $.comparison.verdict off these rows", async () => {
    const env = createTestEnv();
    const now = Date.now();
    await seedHistory(env, now);
    const { changed, comparisons, corpusChecksumByRuleId } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 9, changed, comparisons, corpusChecksumByRuleId);

    const row = (await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString()))[0]!;
    expect(row.metadata.constantName).toBe("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR");
    const comparison = row.metadata.comparison as { ruleId: string; verdict: string };
    expect(comparison.ruleId).toBe("linked_issue_scope_mismatch");
    expect(typeof comparison.verdict).toBe("string");
  });

  it("checksums the corpus that was SCORED, not a fresh read -- a later override does not move the freeze point", async () => {
    // The freeze point has to describe the cases the verdict came from. If it were re-read at persist time,
    // a reader re-deriving from it would get numbers that disagree with the published ones and conclude the
    // publication was wrong.
    const env = createTestEnv();
    const now = Date.now();
    await seedHistory(env, now);
    const { changed, comparisons, corpusChecksumByRuleId } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    const frozen = corpusChecksumByRuleId.get("linked_issue_scope_mismatch");

    await createSignalStore(env).recordRuleFired({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#999",
      outcome: "unaddressed",
      occurredAt: new Date(now - 2000).toISOString(),
      metadata: { confidence: 0.99 },
    });
    await createSignalStore(env).recordHumanOverride({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#999",
      verdict: "reversed",
      occurredAt: new Date(now - 1500).toISOString(),
    });
    await persistThresholdBacktestRuns(env, "acme/widgets", 11, changed, comparisons, corpusChecksumByRuleId);

    const row = (await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString()))[0]!;
    expect(row.metadata.corpusChecksum).toBe(frozen);
  });

  it("omits corpusChecksum entirely (never null) when a direct caller supplies no map, so the reader's IS NOT NULL filter stays the single gate", async () => {
    const env = createTestEnv();
    const now = Date.now();
    await seedHistory(env, now);
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 13, changed, comparisons);

    const row = (await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString()))[0]!;
    expect("corpusChecksum" in row.metadata).toBe(false);
  });

  it("still records a freeze point for a ruleId whose corpus read FAILED -- the empty corpus is a true statement about what was backtested", async () => {
    // fetchCorpus degrades a failed read to [], and that is genuinely what got scored. The reader is what
    // refuses to publish against EMPTY_CORPUS_CHECKSUM; the writer must not silently omit the field and make
    // a failed read indistinguishable from an old deployment that never wrote one.
    const env = createTestEnv();
    const now = Date.now();
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      queryRuleHistory: () => Promise.reject(new Error("simulated read failure")),
    } as unknown as ReturnType<typeof signalTrackingWire.createSignalStore>);

    const { changed, comparisons, corpusChecksumByRuleId } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    vi.restoreAllMocks();
    await persistThresholdBacktestRuns(env, "acme/widgets", 15, changed, comparisons, corpusChecksumByRuleId);

    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString());
    if (rows.length > 0) expect(rows[0]!.metadata.corpusChecksum).toBe(checksumCases([]));
    expect(corpusChecksumByRuleId.get("linked_issue_scope_mismatch")).toBe(checksumCases([]));
  });
});
