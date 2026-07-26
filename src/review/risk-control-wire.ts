// Risk-control recalibration wire (#8835) — the IO around src/review/risk-control.ts's pure math.
//
// Reads (adjudication, decision-time confidence) pairs — human labels from decision_audit_labels (#8830/
// #8831) joined to the confidence each decision persisted in its decision record (#8834) — runs the
// fixed-sequence calibration PER ARM (Neyman–Pearson: a wrong merge costs more than a wrong close, so each
// arm carries its own α), and publishes the result: a calibrated λ̂ lands in system_flags plus an audit
// event carrying the certified statement; an under-powered set DELETES any stale λ̂ (a stale guarantee is a
// lie) and audits the shortfall so the label-collection burn-down is visible.
//
// DELIBERATELY CONSULT-ONLY in this change: the calibrated λ̂ is not yet wired into the live gate floor,
// because ai_review_close_confidence already has an automatic writer (the backtest-gated knob loosening,
// #8121/#8158) and two auto-writers on one knob need an explicit precedence rule first — that decision is
// tracked on #8835. Flag-gated by LOOPOVER_RISK_CONTROL (default OFF, byte-identical).
import { calibrateActThreshold, type CalibrationPair, type CalibrationResult } from "./risk-control";
import { recordAuditEvent } from "../db/repositories";
import { errorMessage, nowIso } from "../utils/json";

export function isRiskControlEnabled(env: { LOOPOVER_RISK_CONTROL?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test((env.LOOPOVER_RISK_CONTROL ?? "").trim());
}

/** Per-arm error budgets (#8835's Neyman–Pearson requirement) and the calibration confidence level. */
export const RISK_CONTROL_ARMS = [
  { arm: "close" as const, verdict: "close" as const, alpha: 0.015 },
  { arm: "merge" as const, verdict: "merge" as const, alpha: 0.002 },
];
export const RISK_CONTROL_DELTA = 0.05;

/** system_flags key holding one arm's calibrated result (JSON). */
export function riskControlFlagKey(arm: string): string {
  return `riskcontrol:${arm}`;
}

/** Labeled pairs for one arm: adjudicated correct/incorrect labels (uncertain is EXCLUDED both sides — the
 *  rubric's contract) joined to the decision-time confidence the record persisted. Rows whose record carries
 *  no aiConfidence (rule-only decisions) cannot join a confidence-thresholded guarantee and are skipped. */
export async function loadCalibrationPairs(env: Env, verdict: "close" | "merge"): Promise<CalibrationPair[]> {
  const { results } = await env.DB.prepare(
    `SELECT dal.adjudication AS adjudication, dr.record_json AS recordJson
       FROM decision_audit_labels dal
       JOIN decision_records dr ON dr.repo_full_name || '#' || dr.pull_number = dal.target_id
      WHERE dal.status = 'adjudicated'
        AND dal.adjudication IN ('correct', 'incorrect')
        AND dal.verdict = ?`,
  )
    .bind(verdict)
    .all<{ adjudication: "correct" | "incorrect"; recordJson: string }>();
  const pairs: CalibrationPair[] = [];
  for (const row of results) {
    try {
      const record = JSON.parse(row.recordJson) as { aiConfidence?: number | null };
      if (typeof record.aiConfidence === "number") {
        pairs.push({ confidence: record.aiConfidence, correct: row.adjudication === "correct" });
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "risk_control_pair_parse_error", message: errorMessage(error).slice(0, 120) }));
    }
  }
  return pairs;
}

/** One arm's recalibration: calibrate → publish or retract. Best-effort per arm. */
async function recalibrateArm(env: Env, arm: string, verdict: "close" | "merge", alpha: number): Promise<CalibrationResult> {
  const pairs = await loadCalibrationPairs(env, verdict);
  const result = calibrateActThreshold(pairs, alpha, RISK_CONTROL_DELTA);
  if (result.status === "calibrated") {
    await env.DB.prepare(`INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(riskControlFlagKey(arm), JSON.stringify({ ...result, calibratedAt: nowIso() }), nowIso())
      .run();
    await recordAuditEvent(env, {
      eventType: "risk_control_calibrated",
      actor: null,
      targetKey: `riskcontrol:${arm}`,
      outcome: "completed",
      detail: `${arm} arm: P(wrong | acted) ≤ ${alpha} guaranteed at ${Math.round(result.coverageAtLambda * 1000) / 10}% coverage (λ=${result.lambda}, n=${result.nAtLambda}, 1−δ=${1 - RISK_CONTROL_DELTA})`,
      metadata: { arm, ...result },
    });
  } else {
    // A stale guarantee is a lie: retract any previously-published λ̂ the moment the data stops supporting it.
    await env.DB.prepare(`DELETE FROM system_flags WHERE key = ?`).bind(riskControlFlagKey(arm)).run();
    await recordAuditEvent(env, {
      eventType: "risk_control_insufficient",
      actor: null,
      targetKey: `riskcontrol:${arm}`,
      outcome: "completed",
      detail: `${arm} arm: cannot certify α=${alpha} — ${result.have} usable label(s) of ${result.needed} needed`,
      metadata: { arm, ...result },
    });
  }
  return result;
}

/** The daily tick: recalibrate every arm. Returns per-arm results for the caller's log line. */
export async function runRiskControlRecalibration(env: Env): Promise<Record<string, CalibrationResult["status"]>> {
  const summary: Record<string, CalibrationResult["status"]> = {};
  for (const { arm, verdict, alpha } of RISK_CONTROL_ARMS) {
    try {
      summary[arm] = (await recalibrateArm(env, arm, verdict, alpha)).status;
    } catch (error) {
      console.warn(JSON.stringify({ event: "risk_control_recalibrate_error", arm, message: errorMessage(error).slice(0, 160) }));
      summary[arm] = "insufficient_labels";
    }
  }
  return summary;
}
