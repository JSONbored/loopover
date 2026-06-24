import { describe, expect, it } from "vitest";
import { computeFleetAnalytics } from "../../src/orb/analytics";
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
    const a = await computeFleetAnalytics(env);
    expect(a.fleet.mergePrecision).toBeCloseTo(0.5); // (1+0)/2
  });
});
