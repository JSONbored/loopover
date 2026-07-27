// Predicted-vs-live gate agreement (#predicted-live-gate-agreement, maintainer review-stack x AMS integration
// audit 2026-07-09) -- a SIBLING to computeGateEval/computeGateParity (src/review/parity.ts), answering a
// DIFFERENT question than either: not "does loopover match reviewbot" (computeGateParity) and not "does one
// system's prediction match the human's realized merge/close" (computeGateEval), but "does the MCP predict_gate
// tool's pre-submission verdict for a contributor match the REAL gate decision their eventual PR receives."
//
// WHY THIS ISN'T computeGateParity WITH A NEW `source`: computeGateParity self-joins review_audit on
// (project, target_id, head_sha) -- a key that only exists once a PR (and a commit) exists. A predicted call
// happens BEFORE the PR exists (predictGateShape has no PR-number field), so there is no head_sha or target_id
// to join on yet. Instead this joins two LOGIN-KEYED tables that already carry the (project, login, timestamp)
// each side actually has available:
//   - predicted_gate_calls (migrations/0137, src/review/predicted-gate-calls.ts) -- the predicted side.
//   - contributor_gate_history (migrations/0126, src/review/contributor-calibration.ts) -- the REAL side,
//     already recorded at the exact same call sites as recordNativeGateDecision, and already login-keyed for
//     exactly this reason (see that migration's own design rationale). This function is its SECOND reader
//     (the first, #2349's personalized confidence adjustment, is still unbuilt) -- reusing it here avoids a
//     second copy of the same real-decision data.
//
// PRIVACY: both source tables are LOCAL-ONLY and login-keyed (never exported via exportOrbBatch). The output
// of this function is an AGGREGATE per-project confusion matrix -- it never surfaces which login contributed
// which paired row. Do not add a per-login breakdown to this report; that is #4517's explicitly separate,
// deliberately-scoped concern (a login-keyed disagreement ledger with its own data-ownership boundary).
//
// Binary action space (unlike computeGateParity's merge/close/hold): the predicted-gate engine and the live
// gate both only ever produce 'merge' or 'hold' (nativeGateActionFromConclusion never returns 'close' -- the
// gate is a CHECK that passes or blocks a merge, it never closes a PR). So the comparison here is 2x2, not 3x3.

import { errorMessage } from "../utils/json";

export interface PredictedAgreementRow {
  project: string;
  /** Predicted calls successfully paired to a real decision within the correlation window. */
  pairedSamples: number;
  /** Both the prediction and the real gate said 'merge'. */
  bothMerge: number;
  /** Both the prediction and the real gate said 'hold'. */
  bothHold: number;
  /** Any pair where the prediction and the real gate disagreed. */
  disagree: number;
  /** (bothMerge + bothHold) / pairedSamples, or null when nothing paired. */
  agreementRate: number | null;
  /** THE misleading direction: the tool predicted 'merge' (told the contributor they were clear) but the real
   *  gate held the PR. The opposite direction (predicted 'hold', real 'merge') costs a contributor a wasted
   *  double-check, not a false all-clear, so it is not called out as a separate safety count here. */
  unsafeDisagreements: number;
}

export interface PredictedAgreementReport {
  rows: PredictedAgreementRow[];
  /** True once at least one project has enough paired evidence to read meaningfully. */
  hasSignal: boolean;
}

/** Same threshold as parity.ts's MIN_PARITY_SAMPLE -- below this the agreement rate is noise. Not exported as
 *  a cutover gate (there is no cutover here); it only gates {@link PredictedAgreementReport.hasSignal}. */
const MIN_PAIRED_SAMPLE = 30;

/** How long after a predicted call a real decision can still be attributed to it. A predict-then-abandon (the
 *  contributor never submits, or submits weeks later on unrelated work) should NOT be paired -- 7 days is
 *  generous enough to cover normal "ask, finish the change, then open the PR" latency without pairing across
 *  genuinely unrelated submissions. */
const DEFAULT_CORRELATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type PredictedCallRow = { project: string; login: string; predicted_action: string; created_at: string };
type RealDecisionRow = { project: string; login: string; decision: string; created_at: string };

const isBinaryAction = (v: string): v is "merge" | "hold" => v === "merge" || v === "hold";

/**
 * Join `predicted_gate_calls` against `contributor_gate_history` by (project, login), pairing each predicted
 * call with the EARLIEST real decision for the same contributor in the same repo that landed within
 * `correlationWindowMs` after the prediction. Multiple predicted calls before one real PR (a contributor
 * iterating on title/scope) all pair against that same eventual decision -- but only the LATEST such call
 * contributes a paired sample (#9138): the real outcome is the honest answer to all of them, so it should be
 * counted ONCE, not once per call. Without this, a contributor calling predict_gate N times before one real
 * merge inflated pairedSamples (and thus agreementRate) by a factor of N -- the exact lever the metric is
 * supposed to measure resistance to. predicted_gate_calls itself still keeps every call's own row (see that
 * module's header) for observability; this dedup is scoped to the AGGREGATE metric computed here.
 *
 * Pure read; fail-safe -> empty report on any D1 error (this must never throw into an ops/dashboard caller).
 */
export async function computePredictedGateAgreement(
  env: Env,
  opts: { days: number; nowMs: number; project?: string; correlationWindowMs?: number },
): Promise<PredictedAgreementReport> {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const correlationWindowMs = Number.isFinite(opts.correlationWindowMs) && (opts.correlationWindowMs as number) > 0 ? (opts.correlationWindowMs as number) : DEFAULT_CORRELATION_WINDOW_MS;
  const fromIso = new Date(opts.nowMs - days * 86_400_000).toISOString();
  // The real-decision read needs a LATER upper bound than the predicted-call read: a prediction made near the
  // end of the `days` window can still be legitimately paired with a real decision up to correlationWindowMs
  // AFTER it, which may fall outside a symmetric `days`-only window.
  const historyToIso = new Date(opts.nowMs + correlationWindowMs).toISOString();

  const projectFilter = opts.project ? "AND project = ?" : "";
  let predicted: PredictedCallRow[] = [];
  let history: RealDecisionRow[] = [];
  try {
    const predictedBinds = opts.project ? [fromIso, opts.project] : [fromIso];
    const predictedRes = await env.DB.prepare(`SELECT project, login, predicted_action, created_at FROM predicted_gate_calls WHERE created_at >= ? ${projectFilter}`)
      .bind(...predictedBinds)
      .all<PredictedCallRow>();
    /* v8 ignore next -- D1's .all() always populates results; the fallback only protects against a driver anomaly. */
    predicted = predictedRes.results ?? [];

    const historyBinds = opts.project ? [fromIso, historyToIso, opts.project] : [fromIso, historyToIso];
    const historyRes = await env.DB.prepare(`SELECT project, login, decision, created_at FROM contributor_gate_history WHERE created_at >= ? AND created_at <= ? ${projectFilter}`)
      .bind(...historyBinds)
      .all<RealDecisionRow>();
    /* v8 ignore next -- same D1 .all() guarantee as the predicted-calls read above. */
    history = historyRes.results ?? [];
  } catch (error) {
    console.warn(JSON.stringify({ event: "predicted_gate_agreement_read_error", message: errorMessage(error).slice(0, 200) }));
    return { rows: [], hasSignal: false };
  }

  // Group the real decisions by (project, login), sorted ascending so the first entry >= a prediction's
  // timestamp is the EARLIEST qualifying real decision.
  const historyByKey = new Map<string, RealDecisionRow[]>();
  for (const row of history) {
    const key = `${row.project} ${row.login}`;
    const bucket = historyByKey.get(key);
    if (bucket) bucket.push(row);
    else historyByKey.set(key, [row]);
  }
  for (const bucket of historyByKey.values()) bucket.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const byProject = new Map<string, PredictedAgreementRow>();
  const row = (p: string): PredictedAgreementRow => {
    let r = byProject.get(p);
    if (!r) {
      r = { project: p, pairedSamples: 0, bothMerge: 0, bothHold: 0, disagree: 0, agreementRate: null, unsafeDisagreements: 0 };
      byProject.set(p, r);
    }
    return r;
  };

  // #9138: collapse every predicted call that would pair against the SAME real decision down to just the
  // LATEST one, keyed by object identity of the paired real-decision row (each row in `history`/`bucket` is a
  // stable reference, so this is safe without a synthetic id column). Without this, a contributor calling
  // loopover_predict_gate N times before one real merge inflated pairedSamples (and thus agreementRate) by a
  // factor of N -- one genuine question asked repeatedly should contribute exactly ONE paired sample, the
  // same honest answer to all of them, not N samples of it.
  const latestPredictionPerRealDecision = new Map<RealDecisionRow, PredictedCallRow>();
  for (const call of predicted) {
    if (!isBinaryAction(call.predicted_action)) continue;
    const bucket = historyByKey.get(`${call.project} ${call.login}`);
    if (!bucket) continue;
    const windowEndIso = new Date(new Date(call.created_at).getTime() + correlationWindowMs).toISOString();
    // Skip PAST a non-binary real decision (e.g. an autonomous 'close' from an unrelated earlier/later PR by
    // the same contributor in the same window) rather than giving up on the whole window at the first hit --
    // otherwise a genuinely comparable later decision would be silently dropped.
    const paired = bucket.find((real) => isBinaryAction(real.decision) && real.created_at >= call.created_at && real.created_at <= windowEndIso);
    if (!paired) continue;

    const existing = latestPredictionPerRealDecision.get(paired);
    if (!existing || call.created_at > existing.created_at) latestPredictionPerRealDecision.set(paired, call);
  }

  for (const [paired, call] of latestPredictionPerRealDecision) {
    const r = row(call.project);
    r.pairedSamples += 1;
    if (call.predicted_action === paired.decision) {
      if (call.predicted_action === "merge") r.bothMerge += 1;
      else r.bothHold += 1;
    } else {
      r.disagree += 1;
      if (call.predicted_action === "merge" && paired.decision === "hold") r.unsafeDisagreements += 1;
    }
  }

  const rows = [...byProject.values()].map((r) => ({
    ...r,
    /* v8 ignore next -- unreachable: row() is only ever created right before pairedSamples += 1 above, so the `: null` arm guards the type only. */
    agreementRate: r.pairedSamples > 0 ? (r.bothMerge + r.bothHold) / r.pairedSamples : null,
  }));
  rows.sort((a, b) => a.project.localeCompare(b.project));
  return { rows, hasSignal: rows.some((r) => r.pairedSamples >= MIN_PAIRED_SAMPLE) };
}
