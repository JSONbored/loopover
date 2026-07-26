// Deterministic decision replay (#8838, epic #8828 Phase 4) — re-derive a decision from its recorded
// inputs and prove it, or find the first divergent stage.
//
// The replay contract mirrors the golden corpus (#8832): `evaluateGateCheck(advisory, policy)` is the pure
// pipeline, and the persisted replay input carries its EXACT inputs (the advisory findings + the resolved
// policy) plus the decision-time evaluation snapshot. Replay is STRUCTURALLY incapable of re-querying the
// model or touching the network: `replayDecision` is a pure function of two JSON values — the no-requery
// guarantee is by construction, not by flag.
//
// Stages, compared in pipeline order (the first mismatch wins — everything after it is downstream noise):
//   1. `conclusion`      — re-evaluated gate conclusion vs the decision-time snapshot.
//   2. `blocker_codes`   — ordered blocker code list (order IS meaning: blockerClass is the first code).
//   3. `reason_code`     — re-derived exactly as the finalize site derives it (blockerClass →
//                          policy_close:<kind> → conclusion) vs the PUBLIC record's reason_code.
// `action` is reported as PINNED, never re-derived: it depends on plan state (autonomy, holds, approvals)
// outside the recorded pipeline — documented v1 scope on #8838.
//
// A divergence is a bug BY DEFINITION (the pipeline is supposed to be deterministic): callers exit non-zero
// and file it; there is no "close enough" outcome.
import { evaluateGateCheck, type GateCheckPolicy } from "../rules/advisory";
import { neutralHoldReasonCode } from "./parity-wire";
import type { Advisory, AdvisoryFinding } from "../types";
import { errorMessage, nowIso } from "../utils/json";

/** What decision_replay_inputs.replay_json holds — the pipeline's exact inputs + the decision-time snapshot. */
export type DecisionReplayInput = {
  findings: AdvisoryFinding[];
  policy: GateCheckPolicy;
  /** The policy-close kind the finalize used in its reasonCode derivation, when one applied. */
  policyCloseKind?: string | null | undefined;
  /** Decision-time evaluation snapshot: what the live pipeline produced from these same inputs. */
  evaluated: { conclusion: string; blockerCodes: string[] };
};

/** The slice of the PUBLIC decision record replay verifies against. */
export type ReplayableRecord = {
  id: string;
  reasonCode: string;
  action: string;
};

export type ReplayOutcome =
  | { verdict: "match"; recordId: string; conclusion: string; blockerCodes: string[]; reasonCode: string; pinnedAction: string }
  | {
      verdict: "divergence";
      recordId: string;
      /** The FIRST divergent stage — later stages are downstream of it and not reported. */
      stage: "conclusion" | "blocker_codes" | "reason_code";
      expected: string;
      actual: string;
    };

/** The finalize site's reasonCode derivation, extracted verbatim so replay and live can never disagree
 *  about the mapping itself (single source of truth — processors.ts finalize imports this too). */
export function deriveDecisionReasonCode(blockerClass: string, policyCloseKind: string | null | undefined, conclusion: string): string {
  return blockerClass !== "none" ? blockerClass : policyCloseKind != null ? `policy_close:${policyCloseKind}` : conclusion;
}

/** blockerClass exactly as agentDispositionLabels derives it from an evaluation: first blocker code, else
 *  the neutral-hold reason, else "none". */
export function deriveBlockerClass(evaluation: { blockers: Array<{ code: string }>; conclusion: string; warnings: AdvisoryFinding[] }): string {
  return evaluation.blockers[0]?.code ?? neutralHoldReasonCode(evaluation as never) ?? "none";
}

/** PURE bit-exact replay. See the module doc for the stage contract. */
export function replayDecision(record: ReplayableRecord, input: DecisionReplayInput): ReplayOutcome {
  const advisory: Advisory = {
    id: `replay-${record.id}`,
    targetType: "pull_request",
    targetKey: record.id,
    repoFullName: "replay/harness",
    pullNumber: 0,
    conclusion: "neutral",
    severity: "info",
    title: "replay",
    summary: "decision replay",
    findings: input.findings,
    generatedAt: "2026-01-01T00:00:00.000Z",
  } as Advisory;
  const evaluation = evaluateGateCheck(advisory, input.policy);
  if (evaluation.conclusion !== input.evaluated.conclusion) {
    return { verdict: "divergence", recordId: record.id, stage: "conclusion", expected: input.evaluated.conclusion, actual: evaluation.conclusion };
  }
  const blockerCodes = evaluation.blockers.map((blocker) => blocker.code);
  if (blockerCodes.join(",") !== input.evaluated.blockerCodes.join(",")) {
    return { verdict: "divergence", recordId: record.id, stage: "blocker_codes", expected: input.evaluated.blockerCodes.join(","), actual: blockerCodes.join(",") };
  }
  const reasonCode = deriveDecisionReasonCode(deriveBlockerClass(evaluation), input.policyCloseKind, evaluation.conclusion);
  if (reasonCode !== record.reasonCode) {
    return { verdict: "divergence", recordId: record.id, stage: "reason_code", expected: record.reasonCode, actual: reasonCode };
  }
  return { verdict: "match", recordId: record.id, conclusion: evaluation.conclusion, blockerCodes, reasonCode, pinnedAction: record.action };
}

/** Persist the replay input beside its record (PRIVATE sibling — see migration 0181). Best-effort: replay
 *  legibility must never break finalization, mirroring persistDecisionRecord's posture. Accepts the gate
 *  EVALUATION and owns the no-replay no-op: content-lane/bridge evaluations are synthetic (their verdicts
 *  come from their own deterministic pipelines, not the advisory evaluator) and carry no replay input —
 *  documented v1 scope on #8838. */
export async function persistDecisionReplayInputForGate(
  env: Env,
  recordId: string,
  gate: { replay?: { findings: AdvisoryFinding[]; policy: GateCheckPolicy } | undefined; conclusion: string; blockers: Array<{ code: string }> },
  policyCloseKind: string | null,
): Promise<void> {
  if (!gate.replay) return;
  await persistDecisionReplayInput(env, recordId, {
    findings: gate.replay.findings,
    policy: gate.replay.policy,
    policyCloseKind,
    evaluated: { conclusion: gate.conclusion, blockerCodes: gate.blockers.map((blocker) => blocker.code) },
  });
}

export async function persistDecisionReplayInput(env: Env, recordId: string, input: DecisionReplayInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO decision_replay_inputs (record_id, replay_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET replay_json = excluded.replay_json, created_at = excluded.created_at`,
    )
      .bind(recordId.slice(0, 250), JSON.stringify(input), nowIso())
      .run();
  } catch (error) {
    console.warn(JSON.stringify({ event: "decision_replay_persist_error", recordId: recordId.slice(0, 120), message: errorMessage(error).slice(0, 160) }));
  }
}
