// Risk-control recalibration wire (#8835) — the IO around src/review/risk-control.ts's pure math.
//
// Reads (adjudication, decision-time confidence) pairs — human labels from decision_audit_labels (#8830/
// #8831) joined to the confidence each decision persisted in its decision record (#8834) — runs the
// calibration PER ARM (Neyman–Pearson: a wrong merge costs more than a wrong close, so each arm carries its
// own α), and publishes the result: a calibrated λ̂ lands in system_flags plus an audit event carrying the
// certified statement. A non-calibrated result DELETES any stale λ̂ (a stale guarantee is a lie) and audits
// the shortfall — but #9048 splits WHICH shortfall into two distinct events, because they need opposite
// remediations: `risk_control_insufficient` (too few usable labels — go collect more) vs
// `risk_control_no_certifiable_threshold` (plenty of labels, but no λ clears alpha — investigate precision,
// or accept a weaker alpha). Conflating the two under one message previously sent the label-collection
// burn-down (#8828) chasing labels a repo already had plenty of.
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
 *  An explicit env α pins the arm; when unset, the CLOSE arm follows the pre-registered α(n) schedule below
 *  and the merge arm stays at 0.005 (~598-label floor — stricter than close by design; the earlier 0.002
 *  draft needed ~1,497 labels, a year of adjudication for the last 3x of strictness, which contradicts the
 *  minimal-human-involvement objective this instrument serves). */
export function riskControlArms(env: Env): Array<{ arm: "close" | "merge"; verdict: "close" | "merge"; alpha: number | null }> {
  return [
    { arm: "close", verdict: "close", alpha: parseBudgetOrNull(env.LOOPOVER_RISK_CONTROL_CLOSE_ALPHA, 0.05) },
    { arm: "merge", verdict: "merge", alpha: parseBudgetOrNull(env.LOOPOVER_RISK_CONTROL_MERGE_ALPHA, 0.05) },
  ];
}

/** Like parseBudget but with no fallback: null when absent/garbage/outside (0, max] — "use the schedule". */
export function parseBudgetOrNull(raw: string | undefined, max: number): number | null {
  const value = Number((raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0 || value > max) return null;
  return value;
}

/**
 * The PRE-REGISTERED α(n) tightening schedule: the strongest error budget the arm's usable label count can
 * power, chosen as a deterministic function of SAMPLE SIZE alone. Because n is information size, not the
 * test statistic, walking this schedule as labels accrue is not outcome-snooping and needs no multiplicity
 * correction — each daily recalibration still runs exactly ONE level-δ test. The alternative (testing an
 * α-grid each day and publishing the strongest pass) would need a Bonferroni δ-split that raises every
 * floor by ~35% and, at today's label volume, certifies nothing at all.
 *
 * Tiers (close): α=0.05 under 350 usable pairs (guarantee arrives at the honest floor of ~59 clean at-λ
 * labels), 0.025 from 350, 0.015 from 700 — the homepage claim self-tightens 95% → 97.5% → 98.5% with zero
 * human steps. Merge: fixed 0.005 until its own volume justifies a schedule (tracked on #8828's epic).
 */
export function scheduledAlpha(arm: "close" | "merge", usablePairs: number): number {
  if (arm === "merge") return 0.005;
  if (usablePairs >= 700) return 0.015;
  if (usablePairs >= 350) return 0.025;
  return 0.05;
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
 *  no aiConfidence (rule-only decisions) cannot join a confidence-thresholded guarantee and are skipped.
 *
 *  The join scopes to the LATEST decision record per PR (decision_records keys one row per head sha, so a
 *  PR reviewed across several pushes accumulates several rows): the label adjudicates the decision that was
 *  ACTED — the latest finalized record, the same latest-row semantics loadDecisionRecordCollapsible renders —
 *  and a bare target_id join would fan one label out into N pairs with different confidences, breaking the
 *  one-label-one-trial contract Clopper–Pearson depends on. `id DESC` breaks created_at ties.
 *
 *  #9050 (latent-risk hardening, not a live bug as of the audit that filed it — every row today already joins
 *  the right action): `AND dr2.action = dal.verdict` requires the latest record to be the SAME disposition the
 *  label adjudicates, so a later HOLD (or MERGE) record on the same PR — a later push whose review cycle ended
 *  differently — can never shadow the CLOSE record the label is actually about, mirroring the sampler's own
 *  `decision IN ('merge','close')` restriction (decision-audit.ts). */
export async function loadCalibrationPairs(env: Env, verdict: "close" | "merge", project: string | null = null): Promise<CalibrationPair[]> {
  const base = `SELECT dal.adjudication AS adjudication, dr.record_json AS recordJson
       FROM decision_audit_labels dal
       JOIN decision_records dr ON dr.id = (
            SELECT dr2.id FROM decision_records dr2
             WHERE dr2.repo_full_name || '#' || dr2.pull_number = dal.target_id
               AND dr2.action = dal.verdict
             ORDER BY dr2.created_at DESC, dr2.id DESC LIMIT 1)
      WHERE dal.status = 'adjudicated'
        AND dal.adjudication IN ('correct', 'incorrect')
        AND dal.verdict = ?`;
  const stmt = project === null ? env.DB.prepare(base).bind(verdict) : env.DB.prepare(`${base} AND LOWER(dal.project) = ?`).bind(verdict, project);
  const { results } = await stmt.all<{ adjudication: "correct" | "incorrect"; recordJson: string }>();
  const pairs: CalibrationPair[] = [];
  for (const row of results) {
    try {
      const record = JSON.parse(row.recordJson) as { aiConfidence?: number | null; configDigest?: unknown };
      if (typeof record.aiConfidence === "number") {
        // #9050: the 2026-07 calibration-corpus backfill stamps this exact sentinel on every record it
        // reconstructed (see scripts/backfill-decision-labels.ts) — it is also that backfill's own
        // provenance marker, deliberately, since the historical resolved config is unrecoverable.
        pairs.push({ confidence: record.aiConfidence, correct: row.adjudication === "correct", backfilled: record.configDigest === "backfill:unavailable" });
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "risk_control_pair_parse_error", message: errorMessage(error).slice(0, 120) }));
    }
  }
  return pairs;
}

/** One arm's recalibration (global when `project` is null, else that repo's own labels): calibrate →
 *  publish or retract. Best-effort per arm. */
async function recalibrateArm(env: Env, arm: "close" | "merge", verdict: "close" | "merge", envAlpha: number | null, project: string | null): Promise<CalibrationResult> {
  const delta = riskControlDelta(env);
  const pairs = await loadCalibrationPairs(env, verdict, project);
  const alpha = envAlpha ?? scheduledAlpha(arm, pairs.length);
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
  } else if (result.status === "insufficient_labels") {
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
  } else {
    // #9048: a DISTINCT outcome from insufficient_labels — this scope has AMPLE labels (result.totalPairs
    // cleared the floor) but no λ ever certified alpha. A distinct event_type keeps the label-collection
    // burn-down (which reads risk_control_insufficient) from conflating "needs labels" with "needs a better
    // error rate" — very different remediations, and only one of them "more labels" can fix.
    await env.DB.prepare(`DELETE FROM system_flags WHERE key = ?`).bind(riskControlFlagKey(scope)).run();
    await recordAuditEvent(env, {
      eventType: "risk_control_no_certifiable_threshold",
      actor: null,
      targetKey: `riskcontrol:${scope}`,
      outcome: "completed",
      detail: `${scope}: ${result.totalPairs} labels available but no threshold achieves α=${alpha} (best upper bound ${Math.round(result.bestUpperBound * 1000) / 1000} at λ=${result.bestLambda}, n=${result.bestN})`,
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
