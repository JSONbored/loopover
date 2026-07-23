import { describe, expect, it } from "vitest";
import {
  loadPublicRulePrecision,
  PUBLIC_PRECISION_MIN_DECIDED,
  PUBLIC_PRECISION_WINDOW_DAYS,
} from "../../src/review/public-rule-precision";
import { recordAuditEvent } from "../../src/db/repositories";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
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
      { ruleId: "ai_consensus_defect", decided: 25, precision: 0.8 },
      { ruleId: "linked_issue_scope_mismatch", decided: 12, precision: 0.75 },
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
    expect(block.rules).toEqual([{ ruleId: "sparse_rule", decided: PUBLIC_PRECISION_MIN_DECIDED - 1, precision: null }]);
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
