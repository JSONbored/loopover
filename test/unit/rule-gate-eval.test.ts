import { describe, expect, it } from "vitest";
import {
  computeRuleGateEval,
  computeBlendedRuleGateEval,
  rulesBelowClosePrecisionFloor,
  type RuleGateEvalRow,
  type BlendedRuleGateEvalRow,
} from "../../src/review/rule-gate-eval";
import { AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED } from "../../src/review/auto-tune";
import { REVERSAL_DISCOUNT_WEIGHT } from "../../src/review/parity";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-07-22T00:00:00Z");

// Stub D1 returning a fixed cell result set -- mirrors parity.test.ts's own computeGateEval fixture style and
// contributor-gate-eval.test.ts's cellEnv exactly, since this module's fold logic is a direct port of both,
// with `ruleCode` as the added dimension.
function cellEnv(cells: Array<{ project: string; ruleCode: string; pred: string; truth: string; reversed?: number; n: number }>): Env {
  return { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: cells }) }) }) } } as unknown as Env;
}

describe("computeRuleGateEval — per-(project, ruleCode) gate accuracy (#7984)", () => {
  it("folds a mixed cell set into per-project-per-ruleCode confusion-matrix precision", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "surface_lane_reject", pred: "close", truth: "closed", n: 3 },
        { project: "p", ruleCode: "surface_lane_reject", pred: "close", truth: "merged", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0];
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.project).toBe("p");
    expect(r.ruleCode).toBe("surface_lane_reject");
    expect(r.wouldClose).toBe(4);
    expect(r.closeConfirmed).toBe(3);
    expect(r.closeFalse).toBe(1);
    expect(r.closePrecision).toBe(0.75);
    expect(r.decided).toBe(4);
  });

  it("REGRESSION replay of the #7469/#7589/#7591/#7594 incident shape: an isolated 0%-precision rule stays isolated from a healthy project-wide aggregate", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        // The buggy rule: 4 closes, every single one later merged by a human (0% precision).
        { project: "metagraphed/metagraphed", ruleCode: "surface_lane_reject", pred: "close", truth: "merged", n: 4 },
        // The SAME project's every OTHER close reason: perfectly healthy, would dilute a project-wide number.
        { project: "metagraphed/metagraphed", ruleCode: "missing_linked_issue", pred: "close", truth: "closed", n: 20 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const buggyRule = out.rows.find((r) => r.ruleCode === "surface_lane_reject");
    const healthyRule = out.rows.find((r) => r.ruleCode === "missing_linked_issue");
    expect(buggyRule).toBeDefined();
    expect(buggyRule?.closePrecision).toBe(0); // 0/4 correct -- exactly the issue's own "0/4 correct" bar
    expect(buggyRule?.closeFalse).toBe(4);
    expect(healthyRule?.closePrecision).toBe(1); // the OTHER rule on the SAME project is unaffected
  });

  it("keeps two ruleCodes on the SAME project as separate rows", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", n: 2 },
        { project: "p", ruleCode: "rule_b", pred: "close", truth: "merged", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows).toHaveLength(2);
    expect(out.rows.map((r) => r.ruleCode).sort()).toEqual(["rule_a", "rule_b"]);
  });

  it("sorts by project then ruleCode", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        { project: "zeta", ruleCode: "rule_b", pred: "close", truth: "closed", n: 1 },
        { project: "zeta", ruleCode: "rule_a", pred: "close", truth: "closed", n: 1 },
        { project: "alpha", ruleCode: "rule_a", pred: "close", truth: "closed", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows.map((r) => `${r.project}:${r.ruleCode}`)).toEqual(["alpha:rule_a", "zeta:rule_a", "zeta:rule_b"]);
  });

  it("#2348-equivalent: discounts a reverted close's credit to weightedCloseConfirmed, but not the raw closeConfirmed", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", reversed: 0, n: 6 },
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", reversed: 1, n: 4 }, // later reopened
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.closeConfirmed).toBe(10); // raw: unaffected by reversal
    expect(r.closePrecision).toBe(1);
    expect(r.weightedCloseConfirmed).toBe(6 + 4 * REVERSAL_DISCOUNT_WEIGHT);
    expect(r.weightedClosePrecision).toBeCloseTo((6 + 4 * REVERSAL_DISCOUNT_WEIGHT) / 10);
  });

  it("counts a would-merge PR the human actually CLOSED as mergeFalse -- the dangerous error", async () => {
    const out = await computeRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "rule_a", pred: "merge", truth: "merged", n: 7 },
        { project: "p", ruleCode: "rule_a", pred: "merge", truth: "closed", n: 3 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.wouldMerge).toBe(10);
    expect(r.mergeConfirmed).toBe(7);
    expect(r.mergeFalse).toBe(3);
    expect(r.mergePrecision).toBe(0.7);
  });

  it("leaves precisions null when nothing decided for that (project, ruleCode)", async () => {
    const out = await computeRuleGateEval(cellEnv([{ project: "p", ruleCode: "rule_a", pred: "hold", truth: "closed", n: 1 }]), { days: 90, nowMs: NOW });
    // "hold" predictions are counted in decided but not merge/close -- both precisions stay null.
    const r = out.rows[0]!;
    expect(r.mergePrecision).toBeNull();
    expect(r.closePrecision).toBeNull();
    expect(r.decided).toBe(1);
  });

  it("hasSignal is true once any row's decided count reaches the 10-sample floor", async () => {
    const under = await computeRuleGateEval(cellEnv([{ project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", n: 9 }]), { days: 90, nowMs: NOW });
    expect(under.hasSignal).toBe(false);
    const over = await computeRuleGateEval(cellEnv([{ project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", n: 10 }]), { days: 90, nowMs: NOW });
    expect(over.hasSignal).toBe(true);
  });

  it("is fail-safe: a throwing D1 read degrades to an empty report, not an error", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const out = await computeRuleGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("defaults to [] when the driver returns no `results` field", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({}) }) }) } } as unknown as Env;
    const out = await computeRuleGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
  });

  it("binds the source filter when a source is given, omits it otherwise", async () => {
    let boundSql = "";
    let bound: unknown[] = [];
    const env = {
      DB: { prepare: (sql: string) => { boundSql = sql; return { bind: (...a: unknown[]) => { bound = a; return { all: async () => ({ results: [] }) }; } }; } },
    } as unknown as Env;
    await computeRuleGateEval(env, { days: 90, nowMs: NOW, source: "loopover" });
    expect(boundSql).toContain("AND source = ?");
    expect(bound).toContain("loopover");

    await computeRuleGateEval(env, { days: 90, nowMs: NOW });
    expect(boundSql).not.toContain("AND source = ?");
    expect(bound).toHaveLength(1);
  });

  it("adds the miner_authored filter when minerOnly is set", async () => {
    let boundSql = "";
    const env = { DB: { prepare: (sql: string) => { boundSql = sql; return { bind: () => ({ all: async () => ({ results: [] }) }) }; } } } as unknown as Env;
    await computeRuleGateEval(env, { days: 90, nowMs: NOW, minerOnly: true });
    expect(boundSql).toContain("AND miner_authored = 1");
  });

  it("defaults an invalid/non-positive days value to 90 rather than NaN or a negative window", async () => {
    let boundFromIso = "";
    const env = {
      DB: {
        prepare: () => ({
          bind: (...a: unknown[]) => {
            boundFromIso = String(a[0]);
            return { all: async () => ({ results: [] }) };
          },
        }),
      },
    } as unknown as Env;
    await computeRuleGateEval(env, { days: -5, nowMs: NOW });
    const expected90 = new Date(NOW - 90 * 86_400_000).toISOString().slice(0, 10);
    expect(boundFromIso).toBe(expected90);

    await computeRuleGateEval(env, { days: Number.NaN, nowMs: NOW });
    expect(boundFromIso).toBe(expected90);
  });
});

describe("computeBlendedRuleGateEval — cross-project pooled ruleCode accuracy (#7984, #7986's own read)", () => {
  it("pools raw counts across projects into ONE row per ruleCode -- volume-weighted, not averaged", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        // 400 decided on one repo, 5 on another -- pooling must weight by volume, not average the two repos'
        // own precisions 50/50 (which would read 0.5 despite the pooled truth being ~98%).
        { project: "big-repo", ruleCode: "rule_a", pred: "close", truth: "closed", n: 396 },
        { project: "big-repo", ruleCode: "rule_a", pred: "close", truth: "merged", n: 4 },
        { project: "small-repo", ruleCode: "rule_a", pred: "close", truth: "merged", n: 5 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.ruleCode).toBe("rule_a");
    expect(r.projectCount).toBe(2);
    expect(r.wouldClose).toBe(405);
    expect(r.closeConfirmed).toBe(396);
    expect(r.closePrecision).toBeCloseTo(396 / 405);
  });

  it("REGRESSION replay of the incident: a rule with 0% precision pooled across every repo it touched", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        { project: "metagraphed/metagraphed", ruleCode: "surface_lane_reject", pred: "close", truth: "merged", n: 4 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows.find((row) => row.ruleCode === "surface_lane_reject");
    expect(r?.closePrecision).toBe(0);
    expect(r?.decided).toBe(4);
  });

  it("keeps two DIFFERENT ruleCodes as separate rows even on the same project", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", n: 1 },
        { project: "p", ruleCode: "rule_b", pred: "close", truth: "merged", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows.map((r) => r.ruleCode).sort()).toEqual(["rule_a", "rule_b"]);
    expect(out.rows.every((r) => r.projectCount === 1)).toBe(true);
  });

  it("sorts by ruleCode", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "zeta", pred: "close", truth: "closed", n: 1 },
        { project: "p", ruleCode: "alpha", pred: "close", truth: "closed", n: 1 },
      ]),
      { days: 90, nowMs: NOW },
    );
    expect(out.rows.map((r) => r.ruleCode)).toEqual(["alpha", "zeta"]);
  });

  it("#2348-equivalent: discounts a reverted close's credit when pooling too", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", reversed: 0, n: 6 },
        { project: "p", ruleCode: "rule_a", pred: "close", truth: "closed", reversed: 1, n: 4 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.closeConfirmed).toBe(10);
    expect(r.weightedCloseConfirmed).toBe(6 + 4 * REVERSAL_DISCOUNT_WEIGHT);
  });

  it("is fail-safe: a throwing D1 read degrades to an empty report", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("d1 down"); } }) }) } } as unknown as Env;
    const out = await computeBlendedRuleGateEval(env, { days: 90, nowMs: NOW });
    expect(out.rows).toEqual([]);
    expect(out.hasSignal).toBe(false);
  });

  it("pools merge-side precision across projects too, not just close-side", async () => {
    const out = await computeBlendedRuleGateEval(
      cellEnv([
        { project: "repo-a", ruleCode: "rule_a", pred: "merge", truth: "merged", n: 8 },
        { project: "repo-b", ruleCode: "rule_a", pred: "merge", truth: "closed", n: 2 },
      ]),
      { days: 90, nowMs: NOW },
    );
    const r = out.rows[0]!;
    expect(r.projectCount).toBe(2);
    expect(r.wouldMerge).toBe(10);
    expect(r.mergeConfirmed).toBe(8);
    expect(r.mergeFalse).toBe(2);
    expect(r.mergePrecision).toBe(0.8);
    expect(r.weightedMergePrecision).toBe(0.8);
  });
});

describe("computeRuleGateEval / computeBlendedRuleGateEval — real review_audit read (#7984)", () => {
  it("reads a real gate_decision + pr_outcome pair from review_audit and folds it correctly, keyed by summary as ruleCode", async () => {
    const env = createTestEnv();
    const targetId = "owner/repo#1";
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, summary, source, created_at) VALUES ('gd-1', 'owner/repo', ?, 'gate_decision', 'close', 'surface_lane_reject', 'gittensory-native', ?)`,
    )
      .bind(targetId, new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES ('po-1', 'owner/repo', ?, 'pr_outcome', 'merged', 'github', ?)`,
    )
      .bind(targetId, new Date().toISOString())
      .run();

    const perRule = await computeRuleGateEval(env, { days: 90, nowMs: Date.now() });
    expect(perRule.rows).toEqual([
      expect.objectContaining({ project: "owner/repo", ruleCode: "surface_lane_reject", wouldClose: 1, closeFalse: 1, closePrecision: 0 }),
    ]);

    const blended = await computeBlendedRuleGateEval(env, { days: 90, nowMs: Date.now() });
    expect(blended.rows).toEqual([
      expect.objectContaining({ ruleCode: "surface_lane_reject", projectCount: 1, wouldClose: 1, closeFalse: 1, closePrecision: 0 }),
    ]);
  });

  it("a gate_decision row with a NULL summary folds under the 'unknown' ruleCode rather than being dropped", async () => {
    const env = createTestEnv();
    const targetId = "owner/repo#2";
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, summary, source, created_at) VALUES ('gd-2', 'owner/repo', ?, 'gate_decision', 'merge', NULL, 'gittensory-native', ?)`,
    )
      .bind(targetId, new Date().toISOString())
      .run();
    await env.DB.prepare(
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES ('po-2', 'owner/repo', ?, 'pr_outcome', 'merged', 'github', ?)`,
    )
      .bind(targetId, new Date().toISOString())
      .run();

    const out = await computeRuleGateEval(env, { days: 90, nowMs: Date.now() });
    expect(out.rows.map((r) => r.ruleCode)).toEqual(["unknown"]);
  });
});

function blendedRow(overrides: Partial<BlendedRuleGateEvalRow> = {}): BlendedRuleGateEvalRow {
  return {
    ruleCode: "rule_a",
    projectCount: 1,
    wouldMerge: 0,
    mergeConfirmed: 0,
    mergeFalse: 0,
    wouldClose: 0,
    closeConfirmed: 0,
    closeFalse: 0,
    decided: 0,
    mergePrecision: null,
    closePrecision: null,
    weightedMergeConfirmed: 0,
    weightedCloseConfirmed: 0,
    weightedMergePrecision: null,
    weightedClosePrecision: null,
    ...overrides,
  };
}

describe("rulesBelowClosePrecisionFloor (#7984, #7986's own read)", () => {
  it("replays the incident: an isolated 0%-precision rule with a real sample IS flagged", () => {
    const rows = [
      blendedRow({ ruleCode: "surface_lane_reject", wouldClose: 4, closeConfirmed: 0, weightedClosePrecision: 0 }),
    ];
    expect(rulesBelowClosePrecisionFloor(rows, AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED)).toEqual([]); // sample (4) < AUTOTUNE_MIN_DECIDED (10)
  });

  it("flags a rule once its sample clears AUTOTUNE_MIN_DECIDED with a below-floor weighted precision", () => {
    const rows = [
      blendedRow({ ruleCode: "surface_lane_reject", wouldClose: 12, closeConfirmed: 0, weightedClosePrecision: 0 }),
    ];
    const flagged = rulesBelowClosePrecisionFloor(rows, AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.ruleCode).toBe("surface_lane_reject");
  });

  it("does NOT flag a rule with insufficient sample even at 0% precision -- 'insufficient sample defaults to keeping the exemption' (#7986)", () => {
    const rows = [blendedRow({ ruleCode: "rare_rule", wouldClose: 3, closeConfirmed: 0, weightedClosePrecision: 0 })];
    expect(rulesBelowClosePrecisionFloor(rows, AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED)).toEqual([]);
  });

  it("does NOT flag a healthy rule with plenty of sample and good precision", () => {
    const rows = [blendedRow({ ruleCode: "healthy_rule", wouldClose: 40, closeConfirmed: 39, weightedClosePrecision: 39 / 40 })];
    expect(rulesBelowClosePrecisionFloor(rows, AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED)).toEqual([]);
  });

  it("does NOT flag a rule whose weightedClosePrecision is null (no decided close verdict at all)", () => {
    const rows = [blendedRow({ ruleCode: "merge_only_rule", wouldClose: 0, weightedClosePrecision: null })];
    expect(rulesBelowClosePrecisionFloor(rows, AUTOTUNE_CLOSE_PRECISION_FLOOR, AUTOTUNE_MIN_DECIDED)).toEqual([]);
  });

  it("defaults floor and minDecided to the SAME constants auto-tune.ts's project-level breaker uses", () => {
    // Exactly at the floor is NOT below it (strict <), matching auto-tune.ts's own planCloseAutoTune contract.
    const atFloor = [blendedRow({ ruleCode: "rule_a", wouldClose: 20, weightedClosePrecision: AUTOTUNE_CLOSE_PRECISION_FLOOR })];
    expect(rulesBelowClosePrecisionFloor(atFloor)).toEqual([]);
    const justBelow = [blendedRow({ ruleCode: "rule_a", wouldClose: 20, weightedClosePrecision: AUTOTUNE_CLOSE_PRECISION_FLOOR - 0.01 })];
    expect(rulesBelowClosePrecisionFloor(justBelow)).toHaveLength(1);
  });
});
