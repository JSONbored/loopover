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

/** Parse an instance-level numeric env override with a hard clamp; the default when absent/garbage/outside
 *  (0, max]. The α/δ budgets are INSTANCE-level instrument parameters (one calibration spans every repo the
 *  instance reviews), so env — the instance's bootstrap config, like LOOPOVER_RISK_CONTROL itself — is their
 *  config-as-code home; a per-repo manifest field would imply a per-repo calibration semantics that does not
 *  exist. */
export function parseBudget(raw: string | undefined, fallback: number, max: number): number {
  const value = Number((raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0 || value > max) return fallback;
  return value;
}

/** Per-arm error budgets (#8835's Neyman–Pearson requirement) and the calibration confidence level.
 *  Defaults: close α=0.015 (~199-label floor), merge α=0.005 (~598 — stricter than close by 3x; the earlier
 *  0.002 draft needed ~1,497 labels, a year of adjudication for the last 3x of strictness, which contradicts
 *  the minimal-human-involvement objective this instrument serves). */
export function riskControlArms(env: Env): Array<{ arm: "close" | "merge"; verdict: "close" | "merge"; alpha: number }> {
  return [
    { arm: "close", verdict: "close", alpha: parseBudget(env.LOOPOVER_RISK_CONTROL_CLOSE_ALPHA, 0.015, 0.05) },
    { arm: "merge", verdict: "merge", alpha: parseBudget(env.LOOPOVER_RISK_CONTROL_MERGE_ALPHA, 0.005, 0.05) },
  ];
}
export function riskControlDelta(env: Env): number {
  return parseBudget(env.LOOPOVER_RISK_CONTROL_DELTA, 0.05, 0.2);
}

/** system_flags key holding one arm's calibrated result (JSON). */
export function riskControlFlagKey(arm: string): string {
  return `riskcontrol:${arm}`;
}

/** Labeled pairs for one arm: adjudicated correct/incorrect labels (uncertain is EXCLUDED both sides — the
 *  rubric's contract) joined to the decision-time confidence the record persisted. Rows whose record carries
 *  no aiConfidence (rule-only decisions) cannot join a confidence-thresholded guarantee and are skipped. */
export async function loadCalibrationPairs(env: Env, verdict: "close" | "merge", project: string | null = null): Promise<CalibrationPair[]> {
  const base = `SELECT dal.adjudication AS adjudication, dr.record_json AS recordJson
       FROM decision_audit_labels dal
       JOIN decision_records dr ON dr.repo_full_name || '#' || dr.pull_number = dal.target_id
      WHERE dal.status = 'adjudicated'
        AND dal.adjudication IN ('correct', 'incorrect')
        AND dal.verdict = ?`;
  const stmt = project === null ? env.DB.prepare(base).bind(verdict) : env.DB.prepare(`${base} AND LOWER(dal.project) = ?`).bind(verdict, project);
  const { results } = await stmt.all<{ adjudication: "correct" | "incorrect"; recordJson: string }>();
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

/** One arm's recalibration (global when `project` is null, else that repo's own labels): calibrate →
 *  publish or retract. Best-effort per arm. */
async function recalibrateArm(env: Env, arm: string, verdict: "close" | "merge", alpha: number, project: string | null): Promise<CalibrationResult> {
  const delta = riskControlDelta(env);
  const pairs = await loadCalibrationPairs(env, verdict, project);
  const result = calibrateActThreshold(pairs, alpha, delta);
  const scope = project === null ? arm : `${arm}:${project}`;
  if (result.status === "calibrated") {
    await env.DB.prepare(`INSERT OR REPLACE INTO system_flags (key, value, updated_at) VALUES (?, ?, ?)`)
      .bind(riskControlFlagKey(scope), JSON.stringify({ ...result, calibratedAt: nowIso() }), nowIso())
      .run();
    await recordAuditEvent(env, {
      eventType: "risk_control_calibrated",
      actor: null,
      targetKey: `riskcontrol:${scope}`,
      outcome: "completed",
      detail: `${scope}: P(wrong | acted) ≤ ${alpha} guaranteed at ${Math.round(result.coverageAtLambda * 1000) / 10}% coverage (λ=${result.lambda}, n=${result.nAtLambda}, 1−δ=${1 - delta})`,
      metadata: { arm, ...result },
    });
  } else {
    // A stale guarantee is a lie: retract any previously-published λ̂ the moment the data stops supporting it.
    await env.DB.prepare(`DELETE FROM system_flags WHERE key = ?`).bind(riskControlFlagKey(scope)).run();
    await recordAuditEvent(env, {
      eventType: "risk_control_insufficient",
      actor: null,
      targetKey: `riskcontrol:${scope}`,
      outcome: "completed",
      detail: `${scope}: cannot certify α=${alpha} — ${result.have} usable label(s) of ${result.needed} needed`,
      metadata: { arm, ...result },
    });
  }
  return result;
}

/** The daily tick: recalibrate every arm globally, then PER-REPO where a repo's own labels clear the floor
 *  (#8835's "per-repo where sample size permits, global fallback otherwise"). A repo key certifies or is
 *  retracted independently of the global one; the actuation read prefers the repo key. Returns per-arm
 *  global statuses for the caller's log line. */
export async function runRiskControlRecalibration(env: Env): Promise<Record<string, CalibrationResult["status"]>> {
  const summary: Record<string, CalibrationResult["status"]> = {};
  for (const { arm, verdict, alpha } of riskControlArms(env)) {
    try {
      summary[arm] = (await recalibrateArm(env, arm, verdict, alpha, null)).status;
      // Per-repo pass: only repos that have EVER produced a label are considered (the query is the label
      // table itself); an under-powered repo is retracted, falling back to the global λ̂ at read time.
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT project FROM decision_audit_labels WHERE status = 'adjudicated' AND verdict = ?",
      )
        .bind(verdict)
        .all<{ project: string }>();
      for (const { project } of results) {
        await recalibrateArm(env, arm, verdict, alpha, project.toLowerCase());
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "risk_control_recalibrate_error", arm, message: errorMessage(error).slice(0, 160) }));
      summary[arm] = "insufficient_labels";
    }
  }
  return summary;
}

// ── Actuation (#8849): the calibrated λ̂ governs the AUTOMATIC floor chain ─────────────────────────────────

/** A resolved automatic close-confidence floor plus its provenance, for the gate policy chain. */
export type AutomaticCloseConfidence = { value: number; calibrated: boolean } | null;

/** Read one arm's published calibration (repo-scoped key first, then global). Fail-OPEN (null) on any read
 *  or parse error — a flags blip must degrade to the static chain, never block or unblock the gate. */
export async function readCalibratedThreshold(env: Env, arm: string, repoFullName?: string | null): Promise<number | null> {
  try {
    const keys = repoFullName ? [riskControlFlagKey(`${arm}:${repoFullName.toLowerCase()}`), riskControlFlagKey(arm)] : [riskControlFlagKey(arm)];
    for (const key of keys) {
      const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?").bind(key).first<{ value: string }>();
      if (row?.value) {
        const parsed = JSON.parse(row.value) as { lambda?: unknown };
        if (typeof parsed.lambda === "number") return parsed.lambda;
      }
    }
    return null;
  } catch (error) {
    console.warn(JSON.stringify({ event: "risk_control_read_error", arm, message: errorMessage(error).slice(0, 120) }));
    return null;
  }
}

/**
 * The precedence rule #8849 exists to decide, implemented: among the AUTOMATIC writers of the AI
 * close-confidence floor, a live calibrated λ̂ (human-label-backed finite-sample guarantee) outranks the
 * backtest-gated knob loosening (#8121/#8158, a throughput optimization under a backtest proxy). Retraction
 * of λ̂ automatically restores the loosening chain — no human step in either direction. An EXPLICIT per-repo
 * `gate.aiReview.closeConfidence` manifest setting still wins over both downstream (gateCheckPolicy's chain):
 * operator config-as-code outranks every automatic writer, in both directions, by standing repo policy.
 */
export async function resolveAutomaticCloseConfidence(env: Env, repoFullName: string | null, knobOverride: number | null): Promise<AutomaticCloseConfidence> {
  if (isRiskControlEnabled(env)) {
    const calibrated = await readCalibratedThreshold(env, "close", repoFullName);
    if (calibrated !== null) return { value: calibrated, calibrated: true };
  }
  return knobOverride !== null ? { value: knobOverride, calibrated: false } : null;
}
