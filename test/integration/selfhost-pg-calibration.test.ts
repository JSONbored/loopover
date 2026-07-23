// Real-Postgres parity suite for the #8082 calibration surfaces (#8171). The Worker-path calibration code
// all reads/writes through env.DB; on self-host that is Postgres behind the pg shim, and every one of these
// paths degrades SILENTLY on a dialect gap (safeAll / fail-safe catches) — so parity must be pinned by
// asserting non-empty results, never just "didn't throw". Skipped unless PG_TEST_URL is set (same contract
// as selfhost-pg.test.ts); run locally against a real PG:
//   docker run -d -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=loopover -p 55432:5432 postgres:16
//   PG_TEST_URL=postgres://postgres:devpw@localhost:55432/loopover npx vitest run test/integration/selfhost-pg-calibration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { splitBacktestCorpus } from "@loopover/engine";
import { runSelfHostMigrations } from "../../src/selfhost/migrate";
import { createPgAdapter } from "../../src/selfhost/pg-adapter";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import * as core from "../../src/services/satisfaction-floor-loosening";
import {
  getSatisfactionFloorOverride,
  loadSatisfactionFloorStatus,
  runSatisfactionFloorLoosening,
  SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
  SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY,
} from "../../src/services/satisfaction-floor-loosening-run";
import { persistThresholdBacktestRuns, runThresholdBacktestAdvisory, THRESHOLD_BACKTEST_EVENT_TYPE } from "../../src/services/threshold-backtest-run";
import { loadCalibrationTrend } from "../../src/services/rule-calibration-trend";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";

const PG_URL = process.env.PG_TEST_URL;
const suite = PG_URL ? describe : describe.skip;

// Own database, so this file and selfhost-pg.test.ts (which drops/recreates ITS public schema) can run in
// the same vitest invocation without racing each other.
const CALIB_DB = "loopover_calibration_parity";

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

suite("Postgres calibration parity (#8171) — real Postgres", () => {
  let pool: pg.Pool;
  let env: Env;

  beforeAll(async () => {
    pg.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10)); // int8 (COUNT) → number, like D1
    const admin = new pg.Pool({ connectionString: PG_URL });
    await admin.query(`DROP DATABASE IF EXISTS ${CALIB_DB}`);
    await admin.query(`CREATE DATABASE ${CALIB_DB}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: withDatabase(PG_URL!, CALIB_DB) });
    const db = createPgAdapter(pool);
    expect(await runSelfHostMigrations(db, "migrations")).toBeGreaterThan(50);
    // The autotune flag ON is part of the surface under test (the loosening loop's write path).
    env = { DB: db, SATISFACTION_FLOOR_AUTOTUNE_ENABLED: "true" } as unknown as Env;
  }, 120_000); // database create + full migration chain legitimately exceeds the 10s hook default
  afterAll(async () => {
    await pool?.end();
  });

  it("capture writers round-trip: rule_fired (incl. bounded raw context metadata) + human_override + queryRuleHistory", async () => {
    const store = createSignalStore(env);
    await store.recordRuleFired({
      ruleId: "ai_consensus_defect",
      targetKey: "acme/widgets#900",
      outcome: "unaddressed",
      occurredAt: new Date(Date.now() - 5000).toISOString(),
      // The #8130/#8129 writers put the bounded raw excerpt in metadata — parity means it survives the
      // pg JSON round-trip byte-for-byte, not merely that the row inserts.
      metadata: { confidence: 0.72, rawContext: { excerpt: "line 12: TODO drop table", truncated: false } },
    });
    await store.recordHumanOverride({
      ruleId: "ai_consensus_defect",
      targetKey: "acme/widgets#900",
      verdict: "reversed",
      occurredAt: new Date().toISOString(),
    });

    const history = await createSignalStore(env).queryRuleHistory("ai_consensus_defect", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]!.metadata).toMatchObject({ confidence: 0.72, rawContext: { excerpt: "line 12: TODO drop table", truncated: false } });
    expect(history.overrides).toHaveLength(1);
    expect(history.overrides[0]!).toMatchObject({ targetKey: "acme/widgets#900", verdict: "reversed" });
  });

  it("threshold backtest: advisory run over a pg-backed corpus produces a comparison and persistThresholdBacktestRuns records it", async () => {
    await seedLooseningFriendlyHistory(env);

    const diff = [
      "diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts",
      "@@ -980,7 +980,7 @@",
      `-export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.5;`,
      `+export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.2;`,
    ].join("\n");
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diff);
    expect(changed).toHaveLength(1);
    expect(comparisons.length).toBeGreaterThan(0); // empty ⇒ the corpus read silently failed on pg

    await persistThresholdBacktestRuns(env, "acme/widgets", 7, changed, comparisons);
    const row = await env.DB.prepare("SELECT target_key, metadata_json FROM audit_events WHERE event_type = ? LIMIT 1")
      .bind(THRESHOLD_BACKTEST_EVENT_TYPE)
      .first<{ target_key: string; metadata_json: string }>();
    expect(row?.target_key).toBe("acme/widgets#7");
    const metadata = JSON.parse(row!.metadata_json) as { comparison: { ruleId: string; verdict: string } };
    expect(metadata.comparison.ruleId).toBe(core.SATISFACTION_FLOOR_RULE_ID);
    expect(typeof metadata.comparison.verdict).toBe("string");
  });

  it("calibration trend re-buckets fired/override/run events from pg with non-zero counts (a dialect gap here degrades silently to zeros)", async () => {
    const report = await loadCalibrationTrend(env);
    const ruleTrend = report.rules.find((rule) => rule.ruleId === core.SATISFACTION_FLOOR_RULE_ID);
    expect(ruleTrend).toBeDefined();
    const fired = ruleTrend!.weeks.reduce((sum, week) => sum + week.fired, 0);
    expect(fired).toBeGreaterThan(0);
    const runs = report.backtestRuns.reduce((sum, week) => sum + week.improved + week.regressed + week.unchanged, 0);
    expect(runs).toBeGreaterThan(0); // the persisted threshold run above must be visible to the trend
  });

  it("loosening loop end-to-end on pg: apply writes the system_flags override + evidence event; status and override reads see both", async () => {
    const result = await runSatisfactionFloorLoosening(env);
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("unreachable");
    expect(result.proposal.proposedFloor).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);

    // The single consumption-point read.
    expect(await getSatisfactionFloorOverride(env)).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
    // The raw row the override rides on (INSERT ... ON CONFLICT upsert through the shim).
    const flag = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?")
      .bind(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY)
      .first<{ value: string }>();
    expect(flag?.value).toBe(String(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]));

    // The operator status surface (/v1/internal/calibration/satisfaction-floor's whole body).
    const status = await loadSatisfactionFloorStatus(env);
    expect(status.flagEnabled).toBe(true);
    expect(status.storedOverride).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
    expect(status.liveFloor).toBe(core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0]);
    expect(status.applied.length).toBeGreaterThan(0);
    expect(status.applied[0]!).toMatchObject({
      currentFloor: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      proposedFloor: core.SATISFACTION_FLOOR_LOOSENING_CANDIDATES[0],
    });

    // And the evidence event itself.
    const evidence = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = ?")
      .bind(SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE)
      .first<{ n: number }>();
    expect(evidence?.n).toBe(1);
  });
});

// Same membership-probe seeding as the unit suite (test/unit/satisfaction-floor-loosening-run.test.ts):
// ask the real splitter which keys land in which slice, then seed borderline-confirmed history in both so
// 0.5 → 0.45 clears the visible AND held-out gates, plus one genuinely-reversed deep-low firing per slice.
async function seedLooseningFriendlyHistory(env: Env): Promise<void> {
  const pool = Array.from({ length: 120 }, (_, i) => `acme/widgets#${i + 1}`);
  const probe = pool.map((targetKey) => ({
    ruleId: core.SATISFACTION_FLOOR_RULE_ID,
    targetKey,
    outcome: "unaddressed",
    label: "confirmed" as const,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
  }));
  const { visible, heldOut } = splitBacktestCorpus(probe, core.SATISFACTION_FLOOR_HELD_OUT_FRACTION, core.SATISFACTION_FLOOR_SPLIT_SEED);
  const store = createSignalStore(env);
  const now = Date.now();
  const keys = [
    ...visible.slice(0, core.SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 4).map((c) => c.targetKey),
    ...heldOut.slice(0, core.SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 2).map((c) => c.targetKey),
  ];
  for (const [i, targetKey] of keys.entries()) {
    await store.recordRuleFired({
      ruleId: core.SATISFACTION_FLOOR_RULE_ID,
      targetKey,
      outcome: "unaddressed",
      occurredAt: new Date(now - 10_000 - i).toISOString(),
      metadata: { confidence: 0.47 },
    });
    await store.recordHumanOverride({ ruleId: core.SATISFACTION_FLOOR_RULE_ID, targetKey, verdict: "confirmed", occurredAt: new Date(now - i).toISOString() });
  }
  for (const targetKey of [visible[core.SATISFACTION_FLOOR_MIN_VISIBLE_CASES + 5]!.targetKey, heldOut[core.SATISFACTION_FLOOR_MIN_HELD_OUT_CASES + 3]!.targetKey]) {
    await store.recordRuleFired({
      ruleId: core.SATISFACTION_FLOOR_RULE_ID,
      targetKey,
      outcome: "unaddressed",
      occurredAt: new Date(now - 20_000).toISOString(),
      metadata: { confidence: 0.1 },
    });
    await store.recordHumanOverride({ ruleId: core.SATISFACTION_FLOOR_RULE_ID, targetKey, verdict: "reversed", occurredAt: new Date(now - 5000).toISOString() });
  }
}
