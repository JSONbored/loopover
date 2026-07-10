import { describe, expect, it } from "vitest";
import { buildOperatorDashboardPayload, latestUsageRollup } from "../../src/services/operator-dashboard";
import type { ProductUsageDailyRollupRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

const FORBIDDEN_EXPORT_TERMS =
  /wallet|hotkey|raw trust|trust[-\s]?score|payout|reward[-\s]?estimate|farming|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)|\/Users|github_pat|ghp_/i;

describe("operator dashboard payload", () => {
  it("builds operator metrics from product usage rollups without sensitive strings", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "operator-dashboard-test-salt" });
    const payload = await buildOperatorDashboardPayload(env);
    const serialized = JSON.stringify(payload);

    expect(payload.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Product events" }),
        expect.objectContaining({ label: "Command usefulness" }),
        expect.objectContaining({ label: "Activation rollups" }),
      ]),
    );
    expect(payload.weeklyValueReport.variant).toBe("operator");
    expect(payload.usageSummary).toMatchObject({ totalEvents: expect.any(Number), activeActors: expect.any(Number) });
    expect(payload.commandUsefulness.totals).toMatchObject({ feedbackCount: expect.any(Number) });
    expect(serialized).not.toMatch(FORBIDDEN_EXPORT_TERMS);
    // #2191: gate-eval report is surfaced read-only; with no review_audit signal it fails safe to an empty
    // report (no rows, no signal) rather than being absent.
    expect(payload.gateEval).toEqual({ rows: [], hasSignal: false });
    // #2192: fleet-wide calibration fails safe to an all-zero/null-discriminates report, never absent.
    expect(payload.calibration.slop).toMatchObject({ totalResolved: 0, overallMergeRate: null, discriminates: null });
    expect(payload.calibration.recommendations).toMatchObject({ total: 0, positiveRate: null });
    expect(payload.calibration.signals.length).toBeGreaterThan(0);
    expect(payload.cycleTime).toEqual({
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      distribution: [],
      sampleSize: 0,
    });
    // Empty fleet → instanceCount 0, null precision card ("—"), no-outlier delta.
    expect(payload.fleetMetrics.instanceCount).toBe(0);
    expect(payload.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fleet instances", value: "0", delta: "self-host fleet" }),
        expect.objectContaining({ label: "Fleet merge precision", value: "—" }),
      ]),
    );
  });

  it("surfaces populated fleet metrics + outliers from orb_signals", async () => {
    const env = createTestEnv();
    let n = 0;
    const seed = async (instance: string, count: number, outcome: string): Promise<void> => {
      for (let i = 0; i < count; i++) {
        await env.DB
          .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', ?, 'none')`)
          .bind(instance, `r${n}`, `p${n++}`, outcome)
          .run();
      }
    };
    await seed("good1", 5, "merged"); // precision 1.0
    await seed("good2", 5, "merged"); // precision 1.0
    await seed("bad", 5, "closed"); // precision 0.0 → outlier vs the median (1.0)
    for (const id of ["good1", "good2", "bad"]) {
      await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)`).bind(id).run(); // only registered instances count
    }
    const payload = await buildOperatorDashboardPayload(env);
    expect(payload.fleetMetrics.instanceCount).toBe(3);
    expect(payload.fleetMetrics.outliers.map((o) => o.instanceId)).toContain("bad");
    expect(payload.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fleet instances", value: "3", delta: "1 outlier(s)" }),
        expect.objectContaining({ label: "Fleet merge precision", value: "100%" }),
      ]),
    );
  });

  it("picks the newest rollup day for adoption insights", () => {
    const rollups: ProductUsageDailyRollupRecord[] = [
      rollup("2026-05-28"),
      rollup("2026-05-30"),
      rollup("2026-05-29"),
    ];
    expect(latestUsageRollup(rollups)?.day).toBe("2026-05-30");
    expect(latestUsageRollup([])).toBeNull();
  });
});

function rollup(day: string): ProductUsageDailyRollupRecord {
  return {
    day,
    status: "complete",
    totalEvents: 1,
    activeActors: 1,
    activeSessions: 1,
    activeRepos: 1,
    sourceEventCount: 1,
    maxEventCapacity: 1000,
    bySurface: [],
    byOutcome: [],
    byEvent: [],
    byRepo: [],
    byCommand: [],
    byTool: [],
    byRouteClass: [],
    activation: {
      loginActors: 1,
      doctorPassActors: 1,
      firstUsefulActionActors: 1,
      fullyActivatedActors: 1,
      githubInstalledRepos: 1,
      githubFirstCommandRepos: 1,
      githubUsefulMaintainerRepos: 1,
      githubActivatedRepos: 1,
    },
    byRole: [{ role: "miner", count: 1, activeActors: 1, activeRepos: 0 }],
    activationByRole: [
      {
        role: "miner",
        loginActors: 1,
        doctorPassActors: 1,
        firstUsefulActionActors: 1,
        fullyActivatedActors: 1,
        githubInstalledRepos: 0,
        githubFirstCommandRepos: 0,
        githubUsefulMaintainerRepos: 0,
        githubActivatedRepos: 0,
      },
    ],
    activationBySurface: [],
    retention: [],
    generatedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
