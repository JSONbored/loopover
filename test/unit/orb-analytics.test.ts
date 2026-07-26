import { describe, expect, it } from "vitest";
import { computeFleetAnalytics, getFleetHealthSummary, HEALTH_STALE_HOURS } from "../../src/orb/analytics";
import { createTestEnv, TestD1Database } from "../helpers/d1";

let seq = 0;
/** Insert N orb_signals rows for one instance with a fixed verdict/outcome/reversal/cycle. */
async function signals(
  env: Env,
  instance: string,
  n: number,
  o: { verdict?: string | null; outcome?: string; reversal?: string; ms?: number | null } = {},
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await env.DB
      .prepare(
        `INSERT INTO orb_signals (instance_id, repo_hash, pr_hash, gate_verdict, outcome, reversal_flag, time_to_close_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(instance, `repo${seq}`, `pr${seq++}`, o.verdict ?? "merge", o.outcome ?? "merged", o.reversal ?? "none", o.ms ?? null)
      .run();
  }
}

/** Opt instances into fleet calibration — only registered instances count toward instanceCount/fleet. */
async function register(env: Env, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await env.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES (?, 1) ON CONFLICT(instance_id) DO UPDATE SET registered=1`).bind(id).run();
  }
}

describe("computeFleetAnalytics()", () => {
  it("empty store → zeroed report (and a custom/clamped window)", async () => {
    const env = createTestEnv();
    const a = await computeFleetAnalytics(env, { windowDays: 30 });
    expect(a.windowDays).toBe(30);
    expect(a.instanceCount).toBe(0);
    expect(a.fleet.mergePrecision).toBeNull();
    expect(a.instances).toEqual([]);
    // bad window falls back to default 90
    expect((await computeFleetAnalytics(env, { windowDays: -5 })).windowDays).toBe(90);
    expect((await computeFleetAnalytics(env)).windowDays).toBe(90);
  });

  it("fail-safe on a DB error → empty report", async () => {
    const broken = { DB: { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("boom")) }) }) } } as unknown as Env;
    const a = await computeFleetAnalytics(broken);
    expect(a.instanceCount).toBe(0);
    expect(a.fleet.cycleP50Ms).toBeNull();
  });

  it("tolerates a DB whose .all() omits results (the ?? [] guards)", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: () => Promise.resolve({}) }) }) } } as unknown as Env;
    const a = await computeFleetAnalytics(env);
    expect(a.instanceCount).toBe(0);
    expect(a.instances).toEqual([]);
  });

  it("tolerates a registered-instances query that omits results (registered ?? [])", async () => {
    // matrix/cycle use .bind().all(); the registered-set query uses .all() directly and returns no `results`.
    const env = { DB: { prepare: () => ({ bind: () => ({ all: () => Promise.resolve({ results: [] }) }), all: () => Promise.resolve({}) }) } } as unknown as Env;
    const a = await computeFleetAnalytics(env);
    expect(a.instanceCount).toBe(0);
  });

  it("computes per-instance precision incl. reversals (reverted merge = false positive)", async () => {
    const env = createTestEnv();
    await signals(env, "inst1", 3, { verdict: "merge", outcome: "merged", reversal: "none" }); // confirmed
    await signals(env, "inst1", 1, { verdict: "merge", outcome: "merged", reversal: "reverted" }); // false (reverted)
    await signals(env, "inst1", 1, { verdict: "merge", outcome: "closed" }); // false
    await signals(env, "inst1", 2, { verdict: "close", outcome: "closed" }); // confirmed
    await signals(env, "inst1", 1, { verdict: "hold", outcome: "closed" }); // hold — not scored as merge/close
    const a = await computeFleetAnalytics(env);
    const inst = a.instances.find((i) => i.instanceId === "inst1")!;
    expect(inst.decided).toBe(8);
    expect(inst.mergePrecision).toBeCloseTo(3 / 5); // 3 confirmed of 5 merge verdicts
    expect(inst.fpRate).toBeCloseTo(2 / 5);
    expect(inst.closePrecision).toBe(1); // 2/2
    expect(inst.reversalRate).toBeCloseTo(1 / 8);
  });

  it("counts close-verdict false negatives (close → merged)", async () => {
    const env = createTestEnv();
    await signals(env, "i", 4, { verdict: "close", outcome: "closed" });
    await signals(env, "i", 1, { verdict: "close", outcome: "merged" }); // closeFalse / false negative
    const inst = (await computeFleetAnalytics(env)).instances[0]!;
    expect(inst.closePrecision).toBeCloseTo(4 / 5);
    expect(inst.fnRate).toBeCloseTo(1 / 5);
  });

  it("decisionAccuracy (#8820) scores only merge/close verdicts — holds are excluded and outright mispredictions COUNT", async () => {
    const env = createTestEnv();
    // The live-fleet shape that exposed the bug: a large block of holds plus real mispredictions that carry
    // no reversal marker at all.
    await signals(env, "i", 10, { verdict: "merge", outcome: "merged" }); // confirmed
    await signals(env, "i", 2, { verdict: "merge", outcome: "closed" }); // WRONG, no reversal marker
    await signals(env, "i", 6, { verdict: "close", outcome: "closed" }); // confirmed
    await signals(env, "i", 2, { verdict: "close", outcome: "merged" }); // WRONG, no reversal marker
    await signals(env, "i", 30, { verdict: "hold", outcome: "merged" }); // deferrals — never scored
    const inst = (await computeFleetAnalytics(env)).instances[0]!;
    expect(inst.decisionAccuracy).toBeCloseTo(16 / 20); // 80% over the 20 real decisions
    // The old published formula would have called this ~100% — every miss here is marker-less, and the 30
    // holds dominate its denominator. This gap IS the bug.
    expect(1 - inst.reversalRate).toBe(1);
  });

  it("decisionAccuracy is null for a holds-only instance (no decision to score) and drives the fleet median", async () => {
    const env = createTestEnv();
    await signals(env, "holds-only", 6, { verdict: "hold", outcome: "merged" });
    const holdsOnly = (await computeFleetAnalytics(env)).instances[0]!;
    expect(holdsOnly.decisionAccuracy).toBeNull();

    const env2 = createTestEnv();
    await signals(env2, "a", 8, { verdict: "merge", outcome: "merged" });
    await signals(env2, "a", 2, { verdict: "merge", outcome: "closed" }); // 0.8
    await signals(env2, "b", 9, { verdict: "close", outcome: "closed" });
    await signals(env2, "b", 1, { verdict: "close", outcome: "merged" }); // 0.9
    await env2.DB.prepare(`INSERT INTO orb_instances (instance_id, registered) VALUES ('a', 1), ('b', 1)`).run();
    const fleet = await computeFleetAnalytics(env2);
    expect(fleet.fleet.decisionAccuracy).toBeCloseTo(0.85); // median of 0.8 and 0.9
  });

  it("a superseded close (#8820) disconfirms closePrecision and counts toward reversalRate, exactly like a reopen", async () => {
    const env = createTestEnv();
    await signals(env, "i", 3, { verdict: "close", outcome: "closed", reversal: "none" }); // confirmed
    await signals(env, "i", 1, { verdict: "close", outcome: "closed", reversal: "superseded" }); // work merged via a successor PR — the close was wrong
    await signals(env, "i", 1, { verdict: "close", outcome: "closed", reversal: "reopened" }); // literal reopen — same treatment
    const inst = (await computeFleetAnalytics(env)).instances[0]!;
    expect(inst.closePrecision).toBeCloseTo(3 / 5);
    expect(inst.fnRate).toBeCloseTo(2 / 5);
    expect(inst.reversalRate).toBeCloseTo(2 / 5);
  });

  it("null precision when an instance made no merge verdicts", async () => {
    const env = createTestEnv();
    await signals(env, "inst1", 5, { verdict: "close", outcome: "closed" });
    const inst = (await computeFleetAnalytics(env)).instances[0]!;
    expect(inst.mergePrecision).toBeNull();
    expect(inst.fpRate).toBeNull();
    expect(inst.closePrecision).toBe(1);
  });

  it("fleet uses the median across eligible instances and flags outliers; reports cycle percentiles", async () => {
    const env = createTestEnv();
    await signals(env, "good1", 5, { verdict: "merge", outcome: "merged", ms: 1000 }); // precision 1.0
    await signals(env, "good2", 5, { verdict: "merge", outcome: "merged", ms: 2000 }); // precision 1.0
    await signals(env, "bad", 5, { verdict: "merge", outcome: "closed", ms: 9000 }); // precision 0.0 → outlier
    await signals(env, "tiny", 2, { verdict: "merge", outcome: "closed" }); // below MIN_DECIDED → excluded from fleet
    await register(env, "good1", "good2", "bad", "tiny"); // all trusted; only MIN_DECIDED gates the fleet here
    const a = await computeFleetAnalytics(env);
    expect(a.instanceCount).toBe(3); // good1, good2, bad (tiny excluded)
    expect(a.fleet.mergePrecision).toBe(1); // median of [1,1,0]
    expect(a.outliers.map((o) => o.instanceId)).toContain("bad");
    expect(a.outliers.map((o) => o.instanceId)).not.toContain("good1");
    expect(a.fleet.cycleP50Ms).not.toBeNull();
    expect(a.fleet.cycleP95Ms).not.toBeNull();
  });

  it("median handles an even number of eligible instances", async () => {
    const env = createTestEnv();
    await signals(env, "a", 5, { verdict: "merge", outcome: "merged" }); // 1.0
    await signals(env, "b", 5, { verdict: "merge", outcome: "closed" }); // 0.0
    await register(env, "a", "b");
    const a = await computeFleetAnalytics(env);
    expect(a.fleet.mergePrecision).toBeCloseTo(0.5); // (1+0)/2
  });

  it("excludes unregistered instances from the fleet even with enough volume (registration is the trust gate)", async () => {
    const env = createTestEnv();
    await signals(env, "trusted", 5, { verdict: "merge", outcome: "merged" });
    await signals(env, "stranger", 5, { verdict: "merge", outcome: "closed" }); // enough volume, but NOT registered
    await register(env, "trusted");
    const a = await computeFleetAnalytics(env);
    expect(a.instanceCount).toBe(1); // only the registered instance counts
    expect(a.fleet.mergePrecision).toBe(1); // the stranger's 0.0 does not drag the median
    expect(a.instances.map((i) => i.instanceId)).toContain("stranger"); // still visible per-instance for the operator
  });

  it("excludes unregistered and ineligible instances from fleet cycle percentiles", async () => {
    const env = createTestEnv();
    await signals(env, "trusted", 5, { verdict: "merge", outcome: "merged", ms: 1000 });
    await signals(env, "stranger", 20, { verdict: "merge", outcome: "closed", ms: 31_536_000_000 }); // unregistered poison
    await signals(env, "tiny", 2, { verdict: "merge", outcome: "closed", ms: 31_536_000_000 }); // registered but below MIN_DECIDED
    await register(env, "trusted", "tiny");

    const a = await computeFleetAnalytics(env);

    expect(a.instanceCount).toBe(1);
    expect(a.fleet.mergePrecision).toBe(1);
    expect(a.fleet.cycleP50Ms).toBe(1000);
    expect(a.fleet.cycleP95Ms).toBe(1000);
  });

  it("reports cycle P50 as a nearest-rank percentile, not the upper-half boundary", async () => {
    const env = createTestEnv();
    // Sorted cycle = [1000×5, 3000×5]. The P50 must be a lower-half value, never the maximum.
    await signals(env, "fast", 5, { verdict: "merge", outcome: "merged", ms: 1000 });
    await signals(env, "slow", 5, { verdict: "merge", outcome: "merged", ms: 3000 });
    await register(env, "fast", "slow");
    const a = await computeFleetAnalytics(env);
    expect(a.instanceCount).toBe(2);
    expect(a.fleet.cycleP50Ms).toBe(1000); // floor-based index returned 3000 (the max) here
    expect(a.fleet.cycleP95Ms).toBe(3000);
  });
});

describe("gamingPatternFlags — anti-farming detection (#2350)", () => {
  /** 7 confirmed merges + 3 reverted merges: precision 0.7, reversalRate 0.3. */
  async function normalInstance(env: Env, id: string): Promise<void> {
    await signals(env, id, 7, { verdict: "merge", outcome: "merged", reversal: "none" });
    await signals(env, id, 3, { verdict: "merge", outcome: "merged", reversal: "reverted" });
  }

  it("a normal-distribution fleet (similar volume/precision/reversal everywhere) produces no flag", async () => {
    const env = createTestEnv();
    await normalInstance(env, "a");
    await normalInstance(env, "b");
    await normalInstance(env, "c");
    await register(env, "a", "b", "c");
    const result = await computeFleetAnalytics(env);
    expect(result.instanceCount).toBe(3);
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("an inflated-trivial-volume instance (high volume + high precision + low reversal, all three) flags", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1"); // decided 10, precision 0.7, reversalRate 0.3
    await normalInstance(env, "normal2");
    await normalInstance(env, "normal3");
    // 30 decided (> 2x the fleet median of 10), precision 1.0 (> 0.7 + 0.25), reversalRate 0 (< 0.5 * 0.3).
    await signals(env, "farmer", 30, { verdict: "merge", outcome: "merged", reversal: "none" });
    await register(env, "normal1", "normal2", "normal3", "farmer");

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toHaveLength(1);
    const flag = result.gamingPatternFlags[0]!;
    expect(flag.instanceId).toBe("farmer");
    expect(flag.decided).toBe(30);
    expect(flag.mergePrecision).toBe(1);
    expect(flag.reversalRate).toBe(0);
    expect(flag.fleetMedianDecided).toBe(10);
    expect(flag.fleetMergePrecision).toBeCloseTo(0.7);
    expect(flag.fleetReversalRate).toBeCloseTo(0.3);
    // No identity beyond the same opaque instance handle used everywhere else in the pipeline.
    expect(Object.keys(flag).sort()).toEqual(["decided", "fleetMedianDecided", "fleetMergePrecision", "fleetReversalRate", "instanceId", "mergePrecision", "reversalRate"]);
  });

  it("high precision WITHOUT elevated volume does not flag (precision alone is not the signature)", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1");
    await normalInstance(env, "normal2");
    // Same volume (10) as the normals, but perfect precision and zero reversals.
    await signals(env, "precise", 10, { verdict: "merge", outcome: "merged", reversal: "none" });
    await register(env, "normal1", "normal2", "precise");

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toEqual([]);
    // It IS still caught by the existing, broader outlier check — this test isolates gamingPatternFlags specifically.
    expect(result.outliers.map((o) => o.instanceId)).toContain("precise");
  });

  it("elevated volume WITHOUT elevated precision does not flag (volume alone is not the signature)", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1");
    await normalInstance(env, "normal2");
    // 30 decided (high volume) but the SAME precision/reversal profile as everyone else.
    await signals(env, "busy", 21, { verdict: "merge", outcome: "merged", reversal: "none" });
    await signals(env, "busy", 9, { verdict: "merge", outcome: "merged", reversal: "reverted" });

    await register(env, "normal1", "normal2", "busy");

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("elevated volume + elevated precision but NOT a suspiciously low reversal rate does not flag", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1"); // decided 10, precision 0.7, reversalRate 0.3
    await normalInstance(env, "normal2");
    // 30 decided (high volume). mergePrecision is 25/25 = 1.0 (elevated) -- ONLY the merge-verdict rows count
    // toward it. reversalRate is 5/30 ≈ 0.167, from separate close-verdict reopens -- above the 0.5x-fleet-
    // median floor (0.15), i.e. NOT suspiciously low, so this must not read as "farming".
    await signals(env, "risky", 25, { verdict: "merge", outcome: "merged", reversal: "none" });
    await signals(env, "risky", 5, { verdict: "close", outcome: "closed", reversal: "reopened" });
    await register(env, "normal1", "normal2", "risky");

    const result = await computeFleetAnalytics(env);
    const risky = result.instances.find((i) => i.instanceId === "risky")!;
    expect(risky.mergePrecision).toBe(1);
    expect(risky.reversalRate).toBeCloseTo(5 / 30);
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("an instance with no merge verdicts at all (null mergePrecision) never flags, even alongside a farmer", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1"); // decided 10
    await normalInstance(env, "normal2"); // decided 10
    await signals(env, "farmer", 30, { verdict: "merge", outcome: "merged", reversal: "none" });
    // Every verdict is "close" — mergePrecision is null, so it cannot be flagged on precision regardless of
    // volume. Kept at MIN_DECIDED so it counts toward the fleet without shifting the volume median the farmer
    // is measured against.
    await signals(env, "close-only", 5, { verdict: "close", outcome: "closed", reversal: "none" });
    await register(env, "normal1", "normal2", "farmer", "close-only");

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags.map((f) => f.instanceId)).toEqual(["farmer"]);
  });

  it("no flags when no eligible instance has any merge verdict (fleetMergeP unresolvable)", async () => {
    const env = createTestEnv();
    await signals(env, "a", 10, { verdict: "close", outcome: "closed" });
    await signals(env, "b", 10, { verdict: "close", outcome: "closed" });
    await register(env, "a", "b");

    const result = await computeFleetAnalytics(env);
    expect(result.fleet.mergePrecision).toBeNull();
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("an unregistered instance never flags, even with an extreme farming-shaped pattern", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1");
    await normalInstance(env, "normal2");
    await signals(env, "unregistered-farmer", 30, { verdict: "merge", outcome: "merged", reversal: "none" });
    await register(env, "normal1", "normal2"); // deliberately NOT registering the farmer

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toEqual([]);
    // Still visible per-instance for the operator, same precedent as outliers.
    expect(result.instances.map((i) => i.instanceId)).toContain("unregistered-farmer");
  });

  it("a below-MIN_DECIDED instance never flags, even if registered with an extreme farming-shaped pattern", async () => {
    const env = createTestEnv();
    await normalInstance(env, "normal1");
    await normalInstance(env, "normal2");
    // Only 3 decided (< MIN_DECIDED = 5) — excluded from `eligible` regardless of registration.
    await signals(env, "tiny-farmer", 3, { verdict: "merge", outcome: "merged", reversal: "none" });
    await register(env, "normal1", "normal2", "tiny-farmer");

    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("empty store -> empty gamingPatternFlags (not undefined)", async () => {
    const env = createTestEnv();
    const result = await computeFleetAnalytics(env);
    expect(result.gamingPatternFlags).toEqual([]);
  });

  it("fail-safe on a DB error -> empty gamingPatternFlags", async () => {
    const broken = { DB: { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("boom")) }) }) } } as unknown as Env;
    const result = await computeFleetAnalytics(broken);
    expect(result.gamingPatternFlags).toEqual([]);
  });
});

describe("getFleetHealthSummary() (#4933)", () => {
  const NOW = new Date("2026-07-18T12:00:00.000Z");
  const FRESH = "2026-07-18T11:30:00.000Z"; // 30m ago -- within the staleness window
  const STALE = "2026-07-18T08:00:00.000Z"; // 4h ago -- older than HEALTH_STALE_HOURS

  async function seedInstance(env: Env, id: string, opts: { registered?: boolean; healthy?: number | null; healthReportedAt?: string | null } = {}): Promise<void> {
    await env.DB
      .prepare(`INSERT INTO orb_instances (instance_id, registered, healthy, health_reported_at) VALUES (?, ?, ?, ?)`)
      .bind(id, opts.registered === false ? 0 : 1, opts.healthy ?? null, opts.healthReportedAt ?? null)
      .run();
  }

  it("empty store → all zero", async () => {
    const env = createTestEnv();
    expect(await getFleetHealthSummary(env, NOW)).toEqual({ healthyCount: 0, unhealthyCount: 0, unknownCount: 0, totalCount: 0 });
  });

  it("counts fresh healthy/unhealthy separately, and a never-reported instance as unknown", async () => {
    const env = createTestEnv();
    await seedInstance(env, "h1", { healthy: 1, healthReportedAt: FRESH });
    await seedInstance(env, "h2", { healthy: 1, healthReportedAt: FRESH });
    await seedInstance(env, "u1", { healthy: 0, healthReportedAt: FRESH });
    await seedInstance(env, "n1"); // never reported -- healthy/health_reported_at both NULL
    expect(await getFleetHealthSummary(env, NOW)).toEqual({ healthyCount: 2, unhealthyCount: 1, unknownCount: 1, totalCount: 4 });
  });

  it("a stale health report (older than HEALTH_STALE_HOURS) counts as unknown, not its last-known status", async () => {
    const env = createTestEnv();
    expect(HEALTH_STALE_HOURS).toBeGreaterThan(0);
    await seedInstance(env, "stale-healthy", { healthy: 1, healthReportedAt: STALE });
    await seedInstance(env, "stale-unhealthy", { healthy: 0, healthReportedAt: STALE });
    expect(await getFleetHealthSummary(env, NOW)).toEqual({ healthyCount: 0, unhealthyCount: 0, unknownCount: 2, totalCount: 2 });
  });

  it("excludes unregistered instances entirely, matching computeFleetAnalytics's own trust gate", async () => {
    const env = createTestEnv();
    await seedInstance(env, "reg", { registered: true, healthy: 1, healthReportedAt: FRESH });
    await seedInstance(env, "unreg", { registered: false, healthy: 1, healthReportedAt: FRESH });
    expect(await getFleetHealthSummary(env, NOW)).toEqual({ healthyCount: 1, unhealthyCount: 0, unknownCount: 0, totalCount: 1 });
  });

  it("fails safe to an all-zero summary on a DB read error", async () => {
    const broken = { DB: { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("boom")) }) }) } } as unknown as Env;
    expect(await getFleetHealthSummary(broken, NOW)).toEqual({ healthyCount: 0, unhealthyCount: 0, unknownCount: 0, totalCount: 0 });
  });

  it("defaults `now` to the current time when omitted", async () => {
    const env = createTestEnv();
    await seedInstance(env, "h1", { healthy: 1, healthReportedAt: new Date().toISOString() });
    expect(await getFleetHealthSummary(env)).toEqual({ healthyCount: 1, unhealthyCount: 0, unknownCount: 0, totalCount: 1 });
  });
});
