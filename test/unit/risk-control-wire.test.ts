import { describe, expect, it } from "vitest";
import { isRiskControlEnabled, loadCalibrationPairs, riskControlFlagKey, runRiskControlRecalibration } from "../../src/review/risk-control-wire";
import { processJob } from "../../src/queue/processors";
import { createTestEnv } from "../helpers/d1";

// #8835: the IO around the calibration math. What must never drift: uncertain labels excluded, rule-only
// (no-confidence) decisions skipped, per-arm scoping, publish-on-certify, RETRACT-on-insufficient.
async function seedLabeledDecision(env: Env, n: number, verdict: "close" | "merge", adjudication: "correct" | "incorrect" | "uncertain", aiConfidence: number | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO decision_audit_labels (id, project, target_id, verdict, outcome, stratum, rubric_version, sampled_at, status, adjudication, adjudicated_at)
     VALUES (?, 'o/r', ?, ?, 'closed', 'close_arm', '1', ?, 'adjudicated', ?, ?)`,
  )
    .bind(`audit:o/r#${n}`, `o/r#${n}`, verdict, new Date().toISOString(), adjudication, new Date().toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO decision_records (id, repo_full_name, pull_number, head_sha, action, reason_code, record_digest, record_json, created_at)
     VALUES (?, 'o/r', ?, 'sha', ?, 'r', 'd', ?, ?)`,
  )
    .bind(`record:o/r#${n}@sha`, n, verdict, JSON.stringify({ aiConfidence }), new Date().toISOString())
    .run();
}

describe("isRiskControlEnabled", () => {
  it("default OFF; truthy strings enable", () => {
    expect(isRiskControlEnabled({})).toBe(false);
    expect(isRiskControlEnabled({ LOOPOVER_RISK_CONTROL: "true" })).toBe(true);
  });
});

describe("loadCalibrationPairs", () => {
  it("joins adjudicated labels to their record's confidence; excludes uncertain, rule-only, and the other arm", async () => {
    const env = createTestEnv();
    await seedLabeledDecision(env, 1, "close", "correct", 0.95);
    await seedLabeledDecision(env, 2, "close", "incorrect", 0.6);
    await seedLabeledDecision(env, 3, "close", "uncertain", 0.9); // rubric contract: excluded both sides
    await seedLabeledDecision(env, 4, "close", "correct", null); // rule-only decision: no confidence to threshold
    await seedLabeledDecision(env, 5, "merge", "correct", 0.99); // other arm
    const pairs = await loadCalibrationPairs(env, "close");
    expect(pairs.sort((a, b) => a.confidence - b.confidence)).toEqual([
      { confidence: 0.6, correct: false },
      { confidence: 0.95, correct: true },
    ]);
  });
});

describe("runRiskControlRecalibration", () => {
  it("INSUFFICIENT: retracts any stale flag and audits the shortfall with the burn-down numbers", async () => {
    const env = createTestEnv();
    await env.DB.prepare(`INSERT INTO system_flags (key, value) VALUES (?, 'stale')`).bind(riskControlFlagKey("close")).run();
    await seedLabeledDecision(env, 1, "close", "correct", 0.95);
    const summary = await runRiskControlRecalibration(env);
    expect(summary).toEqual({ close: "insufficient_labels", merge: "insufficient_labels" });
    const flag = await env.DB.prepare(`SELECT value FROM system_flags WHERE key = ?`).bind(riskControlFlagKey("close")).first();
    expect(flag).toBeFalsy(); // a stale guarantee is a lie — retracted
    const audit = await env.DB.prepare(`SELECT detail FROM audit_events WHERE event_type = 'risk_control_insufficient' AND target_key = 'riskcontrol:close'`).first<{ detail: string }>();
    expect(audit!.detail).toContain("of 199 needed"); // close-arm alpha 0.015 floor
  });

  it("CALIBRATED: publishes lambda + the certified statement once the close arm clears its floor", async () => {
    const env = createTestEnv();
    for (let i = 1; i <= 210; i += 1) await seedLabeledDecision(env, i, "close", "correct", 0.9 + (i % 5) / 100);
    const summary = await runRiskControlRecalibration(env);
    expect(summary.close).toBe("calibrated");
    expect(summary.merge).toBe("insufficient_labels"); // merge alpha 0.002 needs 1497 — genuinely separate arms
    const flag = await env.DB.prepare(`SELECT value FROM system_flags WHERE key = ?`).bind(riskControlFlagKey("close")).first<{ value: string }>();
    const stored = JSON.parse(flag!.value) as { lambda: number; coverageAtLambda: number };
    expect(stored.lambda).toBe(0.9);
    expect(stored.coverageAtLambda).toBe(1);
    const audit = await env.DB.prepare(`SELECT detail FROM audit_events WHERE event_type = 'risk_control_calibrated'`).first<{ detail: string }>();
    expect(audit!.detail).toContain("P(wrong | acted) ≤ 0.015 guaranteed at 100% coverage");
  });
});

describe("fail-safe arms", () => {
  it("an unparseable record_json is skipped with a warn — one bad row never voids the pair set", async () => {
    const env = createTestEnv();
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await seedLabeledDecision(env, 1, "close", "correct", 0.95);
    await env.DB.prepare("UPDATE decision_records SET record_json = '{broken' WHERE pull_number = 1").run();
    await seedLabeledDecision(env, 2, "close", "incorrect", 0.6);
    const pairs = await loadCalibrationPairs(env, "close");
    expect(pairs).toEqual([{ confidence: 0.6, correct: false }]);
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("a throwing arm recalibration is contained: the OTHER arm still runs and the summary reports insufficient", async () => {
    const env = createTestEnv();
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("dal.verdict = ?")) {
        return { bind: () => ({ all: async () => { throw new Error("ledger down"); } }) } as never;
      }
      return realPrepare(sql);
    });
    const summary = await runRiskControlRecalibration(env);
    expect(summary).toEqual({ close: "insufficient_labels", merge: "insufficient_labels" });
    expect(warn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("risk-control-recalibrate job dispatch (#8835)", () => {
  it("flag-ON runs; flag-OFF (stale queued job) does zero work", async () => {
    const on = createTestEnv({ LOOPOVER_RISK_CONTROL: "true" });
    await processJob(on, { type: "risk-control-recalibrate", requestedBy: "test" });
    const audited = await on.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'risk_control_%'`).first<{ n: number }>();
    expect(audited!.n).toBe(2); // one insufficient audit per arm

    const off = createTestEnv();
    await processJob(off, { type: "risk-control-recalibrate", requestedBy: "test" });
    const none = await off.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE event_type LIKE 'risk_control_%'`).first<{ n: number }>();
    expect(none!.n).toBe(0);
  });
});
