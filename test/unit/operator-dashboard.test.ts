import { describe, expect, it } from "vitest";
import {
  buildOperatorDashboardPayload,
  clampOperatorDashboardWindowDays,
  latestUsageRollup,
  __operatorDashboardInternals,
} from "../../src/services/operator-dashboard";
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
    expect(payload.cycleTime).toEqual({
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      distribution: [],
      sampleSize: 0,
    });
    expect(payload.calibration).toMatchObject({
      currentFloor: 0,
      mergedCount: 0,
      revertedCount: 0,
      recommendedFloor: null,
      bins: expect.arrayContaining([
        expect.objectContaining({ label: "90–100%", sampleSize: 0, keptRate: null }),
      ]),
    });
    
    expect(payload.agentHealth).toMatchObject({
      reversals: 0,
      reversalRate: 0,
      manualRate: 0,
      recentAutoActions: 0,
      reversedTargets: [],
    });
    // #2196: org-wide slop-band calibration fails safe to an empty calibration when no resolved PR carries a band.
    expect(payload.slopCalibration).toMatchObject({
      totalResolved: 0,
      overallMergeRate: null,
      discriminates: null,
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

  it("falls back to the default agent slug when GITHUB_APP_SLUG is unset or blank", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "operator-dashboard-test-salt" });
    delete (env as Partial<Env>).GITHUB_APP_SLUG;
    const missingSlug = await buildOperatorDashboardPayload(env);
    expect(missingSlug.agentHealth).toMatchObject({
      reversals: 0,
      reversalRate: 0,
      manualRate: 0,
      recentAutoActions: 0,
      reversedTargets: [],
    });

    const blankSlug = await buildOperatorDashboardPayload(
      createTestEnv({ PRODUCT_USAGE_HASH_SALT: "operator-dashboard-test-salt", GITHUB_APP_SLUG: "   " }),
    );
    expect(blankSlug.agentHealth).toMatchObject({
      reversals: 0,
      reversalRate: 0,
      manualRate: 0,
      recentAutoActions: 0,
      reversedTargets: [],
    });
  });

  it("operatorAgentConfig trims a configured slug and falls back when absent", () => {
    const { operatorAgentConfig } = __operatorDashboardInternals;
    expect(operatorAgentConfig(createTestEnv({ GITHUB_APP_SLUG: "  custom-app  " }))).toEqual({
      slug: "custom-app",
      secrets: {},
    });
    expect(operatorAgentConfig(createTestEnv({ GITHUB_APP_SLUG: "gittensory" }))).toEqual({
      slug: "gittensory",
      secrets: {},
    });
    const unset = createTestEnv();
    delete (unset as Partial<Env>).GITHUB_APP_SLUG;
    expect(operatorAgentConfig(unset)).toEqual({ slug: "gittensory", secrets: {} });
    expect(operatorAgentConfig(createTestEnv({ GITHUB_APP_SLUG: "" }))).toEqual({
      slug: "gittensory",
      secrets: {},
    });
  });

  it("buildOrgSlopCalibration (#2196) degrades to an empty calibration when the PR read throws", async () => {
    const { buildOrgSlopCalibration } = __operatorDashboardInternals;
    // A DB whose every access throws forces listAllPullRequests to reject; the fail-safe must swallow it.
    const brokenDb = new Proxy(
      {},
      {
        get() {
          throw new Error("DB unavailable");
        },
      },
    );
    const brokenEnv = { ...createTestEnv(), DB: brokenDb as unknown as D1Database };
    const calibration = await buildOrgSlopCalibration(brokenEnv);
    expect(calibration).toMatchObject({
      totalResolved: 0,
      overallMergeRate: null,
      discriminates: null,
    });
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
        expect.objectContaining({ label: "Fleet gaming-pattern flags", value: "0", delta: "no gaming pattern detected" }),
      ]),
    );
  });

  it("surfaces a fleet farming flag (#2350) as a dedicated dashboard tile naming the flagged instance", async () => {
    const env = createTestEnv();
    let n = 0;
    const seed = async (instance: string, count: number, opts: { reversal?: string } = {}): Promise<void> => {
      for (let i = 0; i < count; i++) {
        await env.DB
          .prepare(`INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag) VALUES (?, ?, ?, 'merge', 'merged', ?)`)
          .bind(instance, `r${n}`, `p${n++}`, opts.reversal ?? "none")
          .run();
      }
    };
    // Two normal instances: decided 10, precision 0.7, reversalRate 0.3 (7 confirmed + 3 reverted).
    for (const id of ["normal1", "normal2"]) {
      await seed(id, 7);
      await seed(id, 3, { reversal: "reverted" });
    }
    // Farmer: decided 30 (> 2x the fleet median volume of 10), precision 1.0 (> 0.7 + 0.25), reversalRate 0.
    await seed("farmer", 30);
    for (const id of ["normal1", "normal2", "farmer"]) {
      await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1)`).bind(id).run();
    }
    const payload = await buildOperatorDashboardPayload(env);
    expect(payload.fleetMetrics.gamingPatternFlags.map((f) => f.instanceId)).toEqual(["farmer"]);
    expect(payload.metrics).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Fleet gaming-pattern flags", value: "1", delta: "farmer" })]));
  });

  it("clamps unsupported window values to the default 7d lookback (#2199)", () => {
    expect(clampOperatorDashboardWindowDays(30)).toBe(30);
    expect(clampOperatorDashboardWindowDays(14)).toBe(7);
  });

  it("threads a custom windowDays through command usefulness metadata (#2199)", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "operator-dashboard-test-salt" });
    const payload = await buildOperatorDashboardPayload(env, { windowDays: 90 });
    expect(payload.commandUsefulness.windowDays).toBe(90);
    expect(payload.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Product events", delta: "last 90 days" }),
      ]),
    );
  });

  it("keeps gate-precision and cycle-time cards on a fixed 90d lookback when windowDays is 7 (#2199)", async () => {
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "operator-dashboard-test-salt" });
    const payload = await buildOperatorDashboardPayload(env, { windowDays: 7 });
    expect(payload.commandUsefulness.windowDays).toBe(7);
    expect(payload.gateEval).toEqual({ rows: [], hasSignal: false });
    expect(payload.cycleTime).toEqual({
      p50Ms: null,
      p90Ms: null,
      p99Ms: null,
      distribution: [],
      sampleSize: 0,
    });
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
