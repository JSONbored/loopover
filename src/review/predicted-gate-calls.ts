// Predicted-gate call history (#predicted-live-gate-agreement, maintainer review-stack x AMS integration
// audit 2026-07-09) -- records EVERY MCP `gittensory_predict_gate`/`gittensory_explain_gate_disposition` call,
// so a later real gate decision for the same (project, login) can be paired against it (see
// src/review/predicted-gate-agreement.ts for the read/join side). Structurally a sibling of
// src/review/contributor-calibration.ts: `review_audit` (migrations/0049) is DELIBERATELY actor-login-free
// (feeds the anonymized orb-collector export), so this is its own separate, LOCAL-ONLY table
// (migrations/0132) -- never wired into exportOrbBatch or any other cross-instance/public export path.
//
// UNLIKE contributor-calibration.ts's per-commit dedup (a re-run at the same head_sha replaces its prior row),
// every predict_gate call gets its OWN row here: there is no commit to dedup against pre-submission, and a
// miner iterating on the same repo (tweaking a title, retrying after a blocker) makes a genuinely new inquiry
// each time -- collapsing them would undercount how often the tool was actually consulted.

import { isParityAuditEnabled, nativeGateActionFromConclusion } from "./parity-wire";
import type { GateCheckConclusion } from "../rules/advisory";
import { isSelfHostedReviewRuntime } from "../selfhost/review-runtime";
import { errorMessage, nowIso } from "../utils/json";

/** The minimal env shape the recorder needs -- mirrors parity-wire.ts's ParityRecorderEnv / contributor-
 *  calibration.ts's ContributorCalibrationEnv exactly, since this records under the identical self-hosted/
 *  parity-flag gate (one flag controls the whole gate-accuracy telemetry family). */
type PredictedGateCallEnv = {
  DB: D1Database;
  LOOPOVER_REVIEW_PARITY_AUDIT?: string | undefined;
  SELFHOST_TRANSIENT_CACHE?: NonNullable<Env["SELFHOST_TRANSIENT_CACHE"]>;
};

/** The minimal verdict shape this recorder needs -- structurally compatible with PredictedGateVerdict
 *  (packages/gittensory-engine), whose `blockers` entries are the public-safe shape (no `severity`), unlike
 *  the real gate's AdvisoryFinding -- so this reads only `.code`, never reusing neutralHoldReasonCode's
 *  stricter AdvisoryFinding-typed signature (see the reasonCode comment below for why that's an acceptable,
 *  deliberately coarser fallback on the predicted side). */
type RecordablePredictedVerdict = {
  conclusion: GateCheckConclusion;
  blockers: Array<{ code: string }>;
};

/**
 * Record one MCP predict_gate/explain_gate_disposition call into `predicted_gate_calls`, keyed by the
 * requested contributor's login. Gated identically to {@link recordNativeGateDecision} in parity-wire.ts (same
 * self-hosted-always-records / cloud-flag-gated contract) -- this is additive telemetry alongside the same
 * gate-accuracy measurement family, not a separate feature with its own on/off knob.
 *
 * Best-effort: a write failure is swallowed (telemetry must never break the MCP tool response). A missing/
 * empty login records nothing -- there is no meaningful per-actor row to write without one.
 */
export async function recordPredictedGateCall(
  env: PredictedGateCallEnv,
  input: { login: string | null | undefined; project: string; verdict: RecordablePredictedVerdict },
): Promise<void> {
  if (!isSelfHostedReviewRuntime(env) && !isParityAuditEnabled(env)) return;
  const login = input.login?.trim();
  if (!login) return;
  const action = nativeGateActionFromConclusion(input.verdict.conclusion);
  if (action === null) return; // "skipped" -- not a comparable prediction (mirrors recordNativeGateDecision)
  const project = input.project.slice(0, 200);
  // Coarser than the real gate_decision's summary (which recovers a specific neutral-hold sub-code via
  // neutralHoldReasonCode): the predicted-gate engine's public verdict shape carries no `severity` on its
  // findings, so it isn't AdvisoryFinding-shaped and can't reuse that stricter-typed helper. reason_code here
  // is an observability aid only (not read by computePredictedGateAgreement's core comparison), so the bare
  // conclusion string is an acceptable fallback for every non-failure case.
  const reasonCode = input.verdict.conclusion === "failure" ? (input.verdict.blockers[0]?.code ?? input.verdict.conclusion) : input.verdict.conclusion;
  try {
    // Every call gets its own row (no dedup key) -- see the module header for why, unlike
    // recordContributorGateDecision's per-commit replace.
    await env.DB.prepare(
      `INSERT INTO predicted_gate_calls (id, login, project, predicted_action, conclusion, reason_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(`predicted:${login}:${project}:${nowIso()}:${Math.random().toString(36).slice(2, 8)}`, login, project, action, input.verdict.conclusion, reasonCode.slice(0, 200), nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "predicted_gate_calls_record_error", project, message: errorMessage(error).slice(0, 200) }));
  }
}
