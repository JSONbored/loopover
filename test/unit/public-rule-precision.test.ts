import { describe, expect, it } from "vitest";
import {
  loadPublicRulePrecision,
  PUBLIC_PRECISION_MIN_DECIDED,
  PUBLIC_PRECISION_WINDOW_DAYS,
  EMPTY_CORPUS_CHECKSUM,
} from "../../src/review/public-rule-precision";
import { sha256Hex } from "../../src/review/decision-record";
import { recordAuditEvent } from "../../src/db/repositories";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { persistThresholdBacktestRuns, runThresholdBacktestAdvisory } from "../../src/services/threshold-backtest-run";
import { createTestEnv } from "../helpers/d1";

// #8230 (epic #8211 track G): the public measured-accuracy block. Load-bearing properties: the public
// number IS the internal number (same events), sparse rules are null (never a misreadable 0%), all three
// reversal shapes count, the reproducibility freeze point surfaces, and nothing target-identifying leaks.

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

async function seedVerdicts(env: Env, ruleId: string, confirmed: number, reversed: number): Promise<void> {
  const store = createSignalStore(env);
  for (let i = 0; i < confirmed + reversed; i += 1) {
    await store.recordHumanOverride({
      ruleId,
      targetKey: `acme/widgets#${i + 1}`,
      verdict: i < confirmed ? "confirmed" : "reversed",
      occurredAt: new Date(NOW - 1000 - i).toISOString(),
    });
  }
}

describe("loadPublicRulePrecision (#8230)", () => {
  it("computes per-rule precision from the same human-verdict events the internal calibration reads, sorted by rule id", async () => {
    const env = createTestEnv();
    await seedVerdicts(env, "linked_issue_scope_mismatch", 9, 3); // 12 decided, precision 0.75
    await seedVerdicts(env, "ai_consensus_defect", 20, 5); // 25 decided, precision 0.8

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.windowDays).toBe(PUBLIC_PRECISION_WINDOW_DAYS);
    expect(block.rules).toEqual([
      { ruleId: "ai_consensus_defect", decided: 25, confirmed: 20, precision: 0.8, unrecognized: 0 },
      { ruleId: "linked_issue_scope_mismatch", decided: 12, confirmed: 9, precision: 0.75, unrecognized: 0 },
    ]);
  });

  it("reports null precision below the public sample floor and excludes events outside the window", async () => {
    const env = createTestEnv();
    await seedVerdicts(env, "sparse_rule", PUBLIC_PRECISION_MIN_DECIDED - 1, 0); // one short of the floor
    // A decided verdict OUTSIDE the trailing window must not count toward anything.
    await createSignalStore(env).recordHumanOverride({
      ruleId: "sparse_rule",
      targetKey: "acme/widgets#999",
      verdict: "confirmed",
      occurredAt: new Date(NOW - (PUBLIC_PRECISION_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString(),
    });

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.rules).toEqual([
      { ruleId: "sparse_rule", decided: PUBLIC_PRECISION_MIN_DECIDED - 1, confirmed: PUBLIC_PRECISION_MIN_DECIDED - 1, precision: null, unrecognized: 0 },
    ]);
  });

  it("REGRESSION: excludes counterfactual-replay rows whose label came from a DIFFERENT rule's human verdicts", async () => {
    // #8277's slop replay copies each label verbatim from the ai_consensus_defect corpus's verdict on the same
    // target, so publishing it under "precision over its human-decided cases" both misattributes the verdict and
    // made the public table print one number twice (both rules showed decided=460/confirmed=287 in production).
    const env = createTestEnv();
    await seedVerdicts(env, "ai_consensus_defect", 15, 5);
    const store = createSignalStore(env);
    for (let i = 0; i < 20; i += 1) {
      await store.recordHumanOverride({
        ruleId: "slop_gate_score",
        targetKey: `acme/widgets#${i + 1}`,
        verdict: i < 15 ? "confirmed" : "reversed",
        occurredAt: new Date(NOW - 1000 - i).toISOString(),
        metadata: { backfilled: true, provenance: "slop_replay_backfill_v1" },
      });
    }

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.rules).toEqual([{ ruleId: "ai_consensus_defect", decided: 20, confirmed: 15, precision: 0.75, unrecognized: 0 }]);
  });

  it("keeps synthesized rows whose labels ARE about the rule they are filed under", async () => {
    // review_targets_decision_level is #8083's own backfill: the labels come from what happened to the PRs that
    // rule fired on, so they support a precision claim for it. Only the cross-rule copy is excluded.
    const env = createTestEnv();
    const store = createSignalStore(env);
    for (let i = 0; i < 12; i += 1) {
      await store.recordHumanOverride({
        ruleId: "ai_consensus_defect",
        targetKey: `acme/widgets#${i + 1}`,
        verdict: i < 9 ? "confirmed" : "reversed",
        occurredAt: new Date(NOW - 1000 - i).toISOString(),
        metadata: { backfilled: true, provenance: "review_targets_decision_level" },
      });
    }

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.rules).toEqual([{ ruleId: "ai_consensus_defect", decided: 12, confirmed: 9, precision: 0.75, unrecognized: 0 }]);
  });

  it("REGRESSION (#9640): a missing or unrecognized $.verdict is counted as unrecognized, never folded into confirmed", async () => {
    // Before the fix, `decided` was COUNT(*) and `confirmed = decided - reversed`, so any row whose verdict
    // was absent or neither 'reversed' nor 'confirmed' inflated confirmed AND cleared the sample floor: this
    // would have reported decided: 15, confirmed: 14, precision: 0.933.
    const env = createTestEnv();
    await seedVerdicts(env, "linked_issue_scope_mismatch", 9, 1);
    for (let i = 0; i < 5; i += 1) {
      await recordAuditEvent(env, {
        eventType: "signal.human_override:linked_issue_scope_mismatch",
        actor: "human",
        targetKey: `acme/widgets#${i + 100}`,
        outcome: "completed",
        metadata: {},
        createdAt: new Date(NOW - 2000 - i).toISOString(),
      });
    }

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.rules).toEqual([
      { ruleId: "linked_issue_scope_mismatch", decided: 10, confirmed: 9, precision: 0.9, unrecognized: 5 },
    ]);
  });

  it("counts all three reversal shapes over the window and surfaces the latest backtest run's corpus checksum", async () => {
    const env = createTestEnv();
    for (const [eventType, count] of [
      ["reversal_reopened", 2],
      ["reversal_reverted", 1],
      ["reversal_superseded", 3],
    ] as const) {
      for (let i = 0; i < count; i += 1) {
        await recordAuditEvent(env, { eventType, targetKey: `acme/widgets#${i}`, outcome: "completed", createdAt: new Date(NOW - 5000 - i).toISOString() });
      }
    }
    // Two runs: the LATEST one's checksum must win; a run without a checksum (threshold-shaped metadata)
    // must never be picked over an older one that carries it.
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      targetKey: "rule",
      outcome: "completed",
      metadata: { corpusChecksum: "older000", comparison: {} },
      createdAt: new Date(NOW - 60_000).toISOString(),
    });
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      targetKey: "rule",
      outcome: "completed",
      metadata: { corpusChecksum: "newest111", comparison: {} },
      createdAt: new Date(NOW - 30_000).toISOString(),
    });
    await recordAuditEvent(env, {
      eventType: "calibration.threshold_backtest_run",
      targetKey: "rule",
      outcome: "completed",
      metadata: { comparison: {} }, // no checksum — filtered out by the query, not coerced
      createdAt: new Date(NOW - 1000).toISOString(),
    });

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.reversals).toEqual({ reopened: 2, reverted: 1, superseded: 3 });
    expect(block.latestBacktestRun).toEqual({ corpusChecksum: "newest111", at: new Date(NOW - 30_000).toISOString() });
  });

  it("reports no freeze point when the latest run's corpus was empty", async () => {
    // Regression: production's latest run carried sha256("[]") -- the checksum of ZERO cases -- and the
    // fairness page rendered it as a "reproducibility freeze point" while /v1/public/eval-scores published
    // records committed to it. A hash over no cases is identical everywhere, so it verifies nothing.
    const env = createTestEnv();
    await seedVerdicts(env, "ai_consensus_defect", 15, 5);
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      targetKey: "rule",
      outcome: "completed",
      metadata: { corpusChecksum: EMPTY_CORPUS_CHECKSUM, comparison: {} },
      createdAt: new Date(NOW - 1000).toISOString(),
    });

    const block = await loadPublicRulePrecision(env, NOW);
    expect(block.latestBacktestRun).toBeNull();
    // The scores come from a different dataset (human-override events) and are unaffected -- an empty corpus
    // means the numbers are uncommitted, never that they are zero.
    expect(block.rules).toEqual([{ ruleId: "ai_consensus_defect", decided: 20, confirmed: 15, precision: 0.75, unrecognized: 0 }]);
  });

  it("EMPTY_CORPUS_CHECKSUM is the exporter's own checksum over zero cases", async () => {
    // scripts/backtest-corpus-export-core.ts hashes `JSON.stringify(cases.map(canonicalizeCase))`, which for
    // an empty list is the two-byte string "[]" -- re-derived here so the constant cannot drift from it.
    expect(EMPTY_CORPUS_CHECKSUM).toBe(await sha256Hex("[]"));
  });

  it("degrades fail-safe on a broken store and reports null freeze point on a fresh ledger", async () => {
    const empty = await loadPublicRulePrecision(createTestEnv(), NOW);
    expect(empty).toEqual({
      windowDays: PUBLIC_PRECISION_WINDOW_DAYS,
      rules: [],
      reversals: { reopened: 0, reverted: 0, superseded: 0 },
      latestBacktestRun: null,
    });

    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    expect(await loadPublicRulePrecision(broken, NOW)).toEqual(empty);
  });

  it("INVARIANT: the public payload never carries target keys, repos, confidences, or private terms", async () => {
    const env = createTestEnv();
    await seedVerdicts(env, "ai_consensus_defect", 15, 5);
    await recordAuditEvent(env, {
      eventType: "calibration.logic_backtest_run",
      targetKey: "acme/widgets#7",
      outcome: "completed",
      metadata: { corpusChecksum: "abc123", comparison: {} },
      createdAt: new Date(NOW - 1000).toISOString(),
    });
    const serialized = JSON.stringify(await loadPublicRulePrecision(env, NOW));
    expect(serialized).not.toMatch(/acme|#\d|targetKey|confidence|wallet|hotkey|trust|reward|payout/i);
  });
});

// #9639: the reader's `IN ('calibration.threshold_backtest_run', 'calibration.logic_backtest_run')` listed two
// writers but only the CI-side logic one ever satisfied the companion `corpusChecksum IS NOT NULL` filter.
// These pin the in-Worker writer's row as a first-class freeze point, end to end through the real service.
describe("latestBacktestRun from an in-Worker threshold run (#9639)", () => {
  const diff = [
    "diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts",
    "@@ -980,7 +980,7 @@",
    "-export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.5;",
    "+export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.4;",
  ].join("\n");

  const seedAndRun = async (env: Env, now: number) => {
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
    const run = await runThresholdBacktestAdvisory(env, diff, now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 7, run.changed, run.comparisons, run.corpusChecksumByRuleId);
    return run;
  };

  it("REGRESSION: a threshold_backtest_run is now a usable freeze point -- this returned null before the writer emitted corpusChecksum", async () => {
    const env = createTestEnv();
    const now = Date.now();
    const run = await seedAndRun(env, now);

    const block = await loadPublicRulePrecision(env, now);
    expect(block.latestBacktestRun).not.toBeNull();
    expect(block.latestBacktestRun?.corpusChecksum).toBe(run.corpusChecksumByRuleId.get("linked_issue_scope_mismatch"));
    expect(block.latestBacktestRun?.corpusChecksum).not.toBe(EMPTY_CORPUS_CHECKSUM);
  });

  it("still returns null when the same writer ran against an empty corpus -- a hash over zero cases commits to nothing", async () => {
    // No seeded history, so the corpus is empty and its checksum is the rule-independent EMPTY_CORPUS_CHECKSUM.
    // The row IS written (the run happened); the reader is what declines to treat it as a commitment.
    const env = createTestEnv();
    const now = Date.now();
    const run = await runThresholdBacktestAdvisory(env, diff, now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 7, run.changed, run.comparisons, run.corpusChecksumByRuleId);

    expect((await loadPublicRulePrecision(env, now)).latestBacktestRun).toBeNull();
  });
});
