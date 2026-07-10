// Login-keyed predict-gate-vs-live-gate calibration ledger (#4517, maintainer review-stack x AMS integration
// audit 2026-07-09) -- the review stack's OWN tamper-resistant calibration ground truth: one durable row per
// (login, real decision) pairing a contributor's self-reported MCP predict_gate verdict against the REAL gate
// decision their PR actually received.
//
// WHY THIS IS SEPARATE FROM #4516's predicted_gate_calls / computePredictedGateAgreement: that pair answers an
// AGGREGATE, project-level question ("how often does prediction agree with reality"), computed FRESH on every
// read, with no per-login row ever persisted. This ledger persists ONE row per pairing so a FUTURE consumer
// (#2349's personalized gate-prediction confidence tuning) has durable per-actor history to read, without
// re-deriving the join every time.
//
// THE CRITICAL PROPERTY -- READ BEFORE ADDING A CONSUMER OR CALL SITE: this is written EXCLUSIVELY from the
// webhook-driven real-gate-decision path (the same call sites as recordContributorGateDecision in
// src/review/contributor-calibration.ts), and NEVER from any MCP tool or other contributor-reachable surface.
// Both `predicted_action` (read from predicted_gate_calls, itself only ever written by the MCP tool's own
// SERVER-SIDE code, never by a caller-supplied value) and `real_decision` (the queue processor's own computed
// gate action) are values this module has no path for a caller to override or spoof. A miner-writable version
// of this exact data would itself be an anti-farming vector (#2350) -- see contributor-calibration.ts's
// identical design note for the same rationale applied to the plain (non-predicted) side of this ledger.
//
// IMMUTABLE PER (login, project, pr, commit): the row id is deterministic and the insert uses
// `ON CONFLICT DO NOTHING` (never DO UPDATE) -- a webhook replay at the SAME commit is a no-op, never a
// silent overwrite of the originally-recorded pairing. This is a stronger guarantee than
// recordContributorGateDecision's own per-commit REPLACE semantics, deliberately: once this ledger records a
// prediction-vs-outcome pairing, that pairing must never change underneath a future calibration reader.
//
// THIS PR ONLY WRITES THE LEDGER. Nothing reads predicted_gate_calibration_ledger yet -- mirrors
// contributor_gate_history's (migrations/0126) own "write-only, nothing reads yet" precedent; the eventual
// #2349 consumer is explicit future work, deliberately deferred so a personalization-adjustment reader gets
// its own focused review.

import { isParityAuditEnabled } from "./parity-wire";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { errorMessage, nowIso } from "../utils/json";

/** The minimal env shape the recorder needs -- mirrors parity-wire.ts's ParityRecorderEnv / contributor-
 *  calibration.ts's ContributorCalibrationEnv exactly (same gate-accuracy telemetry family, same flag). */
type PredictedGateCalibrationEnv = {
  DB: D1Database;
  GITTENSORY_REVIEW_PARITY_AUDIT?: string | undefined;
  SELFHOST_TRANSIENT_CACHE?: NonNullable<Env["SELFHOST_TRANSIENT_CACHE"]>;
};

/** Same correlation window as src/review/predicted-gate-agreement.ts's DEFAULT_CORRELATION_WINDOW_MS --
 *  kept as an independent constant (not imported) so this module has zero dependency on that one's internals,
 *  but deliberately the SAME value: both answer "was this predicted call related to this real outcome," and a
 *  divergent window here would let the aggregate metric (#4516) and this persisted ledger (#4517) silently
 *  disagree about which pairs count. */
const CORRELATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const isBinaryAction = (v: string): v is "merge" | "hold" => v === "merge" || v === "hold";

type RecentPredictedCall = { predicted_action: string; created_at: string };

/**
 * Record ONE (login, real decision) pairing into `predicted_gate_calibration_ledger`, if -- and only if --
 * this login has a recent (within {@link CORRELATION_WINDOW_MS}) predict_gate call for this SAME repo to pair
 * against. Cold start (no prior prediction) records nothing; there is nothing to calibrate against yet.
 *
 * Gated identically to {@link recordContributorGateDecision} in contributor-calibration.ts (same self-hosted-
 * always-records / cloud-flag-gated contract) -- additive telemetry alongside the same gate-accuracy
 * measurement family, not a separate feature with its own on/off knob. Only a binary (merge/hold) `decision`
 * is comparable to a predict-gate verdict (the predictor never predicts 'close' -- see
 * predicted-gate-agreement.ts's own module header for why); a 'close' or other decision records nothing.
 *
 * Best-effort and fail-safe throughout: a read or write failure is swallowed (telemetry must never break gate
 * finalization). Immutable per (login, project, pr, headSha) -- see the module header.
 */
export async function recordPredictedGateCalibration(
  env: PredictedGateCalibrationEnv,
  input: { login: string | null | undefined; project: string; pullNumber: number; headSha: string | null | undefined; decision: string },
): Promise<void> {
  if (!isSelfHostedReviewRuntime(env) && !isParityAuditEnabled(env)) return;
  const login = input.login?.trim();
  if (!login) return;
  if (!isBinaryAction(input.decision)) return;
  const project = input.project.slice(0, 200);
  const decidedAtIso = nowIso();
  const sinceIso = new Date(Date.now() - CORRELATION_WINDOW_MS).toISOString();

  let predicted: RecentPredictedCall | null;
  try {
    predicted =
      (await env.DB.prepare(
        `SELECT predicted_action, created_at FROM predicted_gate_calls
          WHERE project = ? AND login = ? AND created_at >= ? AND created_at <= ?
          ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(project, login, sinceIso, decidedAtIso)
        .first<RecentPredictedCall>()) ?? null;
  } catch (error) {
    console.warn(JSON.stringify({ event: "predicted_gate_calibration_read_error", project, message: errorMessage(error).slice(0, 200) }));
    return;
  }
  // Cold start (no prior prediction in the window) or a defensively-unexpected non-binary predicted_action --
  // either way, nothing comparable to pair against.
  if (!predicted || !isBinaryAction(predicted.predicted_action)) return;

  const targetId = `${project}#${input.pullNumber}`;
  const agreed = predicted.predicted_action === input.decision;
  try {
    // Deterministic id per (login, project, pr, commit) + ON CONFLICT DO NOTHING (never DO UPDATE): a replay
    // at the SAME commit is a no-op, not a silent overwrite of the originally-recorded pairing.
    await env.DB.prepare(
      `INSERT INTO predicted_gate_calibration_ledger
         (id, login, project, target_id, predicted_action, real_decision, agreed, predicted_at, decided_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
      .bind(
        `calibration:${login}:${project}:${input.pullNumber}@${input.headSha ?? "none"}`,
        login,
        project,
        targetId,
        predicted.predicted_action,
        input.decision,
        agreed ? 1 : 0,
        predicted.created_at,
        decidedAtIso,
        decidedAtIso,
      )
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "predicted_gate_calibration_write_error", project, message: errorMessage(error).slice(0, 200) }));
  }
}
