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
//   0. `clock`           — #9028: the instant the caller asked to replay AT vs the instant the live decision
//                          recorded. Time is a decision input, so replaying a clock-dependent rule at a
//                          DIFFERENT instant is never silently accepted as a match. Skipped when the caller
//                          names no instant (replay at the recorded one) or the record predates #9028.
//   1. `conclusion`      — re-evaluated gate conclusion vs the decision-time snapshot.
//   2. `blocker_codes`   — ordered blocker code list (order IS meaning: blockerClass is the first code).
//   3. `reason_code`     — re-derived exactly as the finalize site derives it (blockerClass →
//                          policy_close:<kind> → conclusion) vs the PUBLIC record's reason_code.
//   4. `holdout_consistency` — #9135: the PUBLIC record's own `divertedByHoldout` claim vs the PRIVATE
//                          replay input's recorded `holdout.diverted` outcome. These are written by the same
//                          call (processors.ts) from the same holdout result, so they can only disagree if
//                          one was updated without the other — a real bug, not a re-derivation gap.
// `action` is reported as PINNED, never re-derived: it depends on plan state (autonomy, holds, approvals)
// outside the recorded pipeline — documented v1 scope on #8838.
//
// #9135 SCOPE (honest, narrower claim over the broader one #8838 made): this replay input additionally
// records the close-audit holdout draw (the ONE unrecorded nondeterministic input #9135 found), but still
// does NOT capture every decision-time input the live plan consults — namely the precision-breaker flag
// state (`isHoldOnly`/`isCloseHoldOnly`, `system_flags`), the live CI aggregate, and the global
// `isGlobalAgentPause`/`isGlobalAgentFrozen` env switches. Each of those can also change which plan a given
// (findings, policy) pair produces, and none of them are in `DecisionReplayInput` as of this stage. Recording
// them is left to a follow-up widening this same input shape — documented here so the replay contract states
// a narrower, honestly-achievable claim rather than an unqualified broad one.
//
// #9492 SCOPE UPDATE (narrowing the gap #9135's note left open): the recorded `clock` instant now reaches
// EVERY clock-dependent read inside the maintenance decision pass, not just `maybeForceFreshRebase`. Newly
// threaded: `activeMergeBlockedSha` (which feeds the plan AND the recorded reason code — previously a
// SECOND, unrecorded `Date.now()` in the very pass that captures this instant), the account-age
// `isNewAccount` derivation (which halves the contributor cap and can flip a cap close), and
// `resolveUnlinkedIssueMatchDisposition`'s velocity exception (whose wall-clock gap chooses CLOSE vs HOLD).
//
// STILL LIVE-CLOCK, deliberately, and named here rather than left to be rediscovered:
//   • The three `isBelowAccountAgeThreshold` callers OUTSIDE this pass (the PR-open cap check, the issue cap
//     check, the issue webhook labeler). Each is its own pass with no captured instant and no replay record,
//     so there is nothing to be consistent WITH; the seam exists on that helper for when one gains a record.
//   • SQL-side `datetime('now', ?)` in src/review/submitter-reputation.ts — a class no JS-side clock seam can
//     cover, since the instant is chosen by the database at statement time.
//   • The precision-breaker flags, the live CI aggregate, and the global pause/freeze switches called out in
//     the #9135 note above — unchanged, still unrecorded.
//
// A divergence is a bug BY DEFINITION (the pipeline is supposed to be deterministic): callers exit non-zero
// and file it; there is no "close enough" outcome.
import { evaluateGateCheck, type GateCheckPolicy } from "../rules/advisory";
import { neutralHoldReasonCode } from "./parity-wire";
import type { DecisionClockCapture } from "./staleness-clock";
import type { Advisory, AdvisoryFinding } from "../types";
import { errorMessage, nowIso } from "../utils/json";

/** The close-audit holdout's decision-time outcome (#9135), persisted beside the pipeline's own inputs so a
 *  hold that was really a diverted close is provable from the replay input, not just claimed by the public
 *  record. `draw` is the [0,1) value compared against `epsilonPct/100`; it is DERIVED (`HMAC(instance
 *  secret, seed)`, see close-audit-holdout.ts), never raw entropy, so persisting it here does not weaken the
 *  "unpredictable to a contributor trying to dodge the holdout" property — recomputing it still requires the
 *  instance secret, which never leaves the operator's environment. */
export type DecisionReplayHoldout = {
  epsilonPct: number;
  draw: number;
  diverted: boolean;
};

/** What decision_replay_inputs.replay_json holds — the pipeline's exact inputs + the decision-time snapshot. */
export type DecisionReplayInput = {
  findings: AdvisoryFinding[];
  policy: GateCheckPolicy;
  /** The policy-close kind the finalize used in its reasonCode derivation, when one applied. */
  policyCloseKind?: string | null | undefined;
  /** Decision-time evaluation snapshot: what the live pipeline produced from these same inputs. */
  evaluated: { conclusion: string; blockerCodes: string[] };
  /** #9135: the close-audit holdout's decision-time outcome, when the holdout mechanism actually drew (an
   *  eligible heuristic close under ε>0 auto autonomy). undefined/null when the holdout never evaluated for
   *  this decision (ε absent/0, close autonomy not auto, or no eligible close) — the overwhelmingly common
   *  case, and the SAME zero-I/O common path `maybeApplyCloseAuditHoldout` already guarantees. */
  holdout?: DecisionReplayHoldout | null | undefined;
  /** #9028: the decision-time wall clock — ONE `Date.now()` read per pass, which every clock-dependent gate
   *  rule (today: `gate.requireFreshRebaseWindow`) reads instead of calling the clock itself. Recorded here so
   *  a replay evaluates time-dependent rules at the instant the LIVE decision used, not at replay time.
   *  undefined/null for a pre-#9028 record — such a record simply has no recorded instant, so the `clock`
   *  stage cannot check anything and is skipped rather than guessed. */
  clock?: DecisionClockCapture | null | undefined;
};

/** The slice of the PUBLIC decision record replay verifies against. */
export type ReplayableRecord = {
  id: string;
  reasonCode: string;
  action: string;
  /** #9135: the PUBLIC record's own claim that the close-audit holdout diverted this decision — checked
   *  against `DecisionReplayInput.holdout.diverted` at the `holdout_consistency` stage. Defaults false for a
   *  pre-#9135 record (mirrors `DecisionRecord.divertedByHoldout`'s own normalization). */
  divertedByHoldout?: boolean;
};

export type ReplayOutcome =
  | { verdict: "match"; recordId: string; conclusion: string; blockerCodes: string[]; reasonCode: string; pinnedAction: string }
  | {
      verdict: "divergence";
      recordId: string;
      /** The FIRST divergent stage — later stages are downstream of it and not reported. */
      stage: "clock" | "conclusion" | "blocker_codes" | "reason_code" | "holdout_consistency";
      expected: string;
      actual: string;
    };

/** #9028: options for a replay run. `nowMs` names the instant the caller wants to replay AT — supply it only
 *  to assert the recorded instant, or to deliberately probe a different one (which must FAIL, never silently
 *  pass). Omitted (the default) means "replay at the recorded instant", which is the bit-exact case. */
export type ReplayOptions = {
  nowMs?: number | undefined;
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
export function replayDecision(record: ReplayableRecord, input: DecisionReplayInput, options: ReplayOptions = {}): ReplayOutcome {
  // #9028 stage 0: TIME IS AN INPUT. A caller that names the instant it is replaying at must be told when
  // that instant is not the one the live decision used — a clock-dependent rule (today
  // `gate.requireFreshRebaseWindow`) can legitimately flip its answer purely because the wall clock moved, so
  // silently replaying at "now" and reporting `match` would certify a re-derivation that never actually
  // reproduced the original evaluation. Checked FIRST: every later stage is evaluated as of this instant.
  // A caller that supplies no instant is replaying at the recorded one by definition, which is the bit-exact
  // path and the CLI's default. A pre-#9028 record has no recorded instant, so there is nothing to contradict
  // and the stage is skipped rather than guessed.
  const recordedNowMs = input.clock?.nowMs;
  if (typeof recordedNowMs === "number" && typeof options.nowMs === "number" && options.nowMs !== recordedNowMs) {
    return { verdict: "divergence", recordId: record.id, stage: "clock", expected: String(recordedNowMs), actual: String(options.nowMs) };
  }
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
  // #9135 stage 4: the PUBLIC record's `divertedByHoldout` claim and the PRIVATE replay input's own
  // `holdout.diverted` outcome are written from the SAME holdout result at the SAME call site — they can
  // only disagree if one was updated without the other, which is a real bug (a hold silently mislabeled as
  // an ordinary decision, or vice versa), not a re-derivation gap the pipeline could ever legitimately close.
  const recordDivertedByHoldout = record.divertedByHoldout ?? false;
  const inputDivertedByHoldout = input.holdout?.diverted ?? false;
  if (recordDivertedByHoldout !== inputDivertedByHoldout) {
    return {
      verdict: "divergence",
      recordId: record.id,
      stage: "holdout_consistency",
      expected: String(recordDivertedByHoldout),
      actual: String(inputDivertedByHoldout),
    };
  }
  return { verdict: "match", recordId: record.id, conclusion: evaluation.conclusion, blockerCodes, reasonCode, pinnedAction: record.action };
}

/** Persist the replay input beside its record (PRIVATE sibling — see migration 0182). Best-effort: replay
 *  legibility must never break finalization, mirroring persistDecisionRecord's posture. Accepts the gate
 *  EVALUATION and owns the no-replay no-op: content-lane/bridge evaluations are synthetic (their verdicts
 *  come from their own deterministic pipelines, not the advisory evaluator) and carry no replay input —
 *  documented v1 scope on #8838. */
export async function persistDecisionReplayInputForGate(
  env: Env,
  recordId: string,
  gate: { replay?: { findings: AdvisoryFinding[]; policy: GateCheckPolicy } | undefined; conclusion: string; blockers: Array<{ code: string }> },
  policyCloseKind: string | null,
  // #9135: the close-audit holdout's decision-time outcome for this same decision, when it drew — threaded
  // straight through to the persisted replay input so `holdout_consistency` has something to check against.
  holdout?: DecisionReplayHoldout | null,
  // #9028: the decision pass's single captured wall-clock instant, so time-dependent rules are replayable.
  clock?: DecisionClockCapture | null,
): Promise<void> {
  if (!gate.replay) return;
  await persistDecisionReplayInput(env, recordId, {
    findings: gate.replay.findings,
    policy: gate.replay.policy,
    policyCloseKind,
    evaluated: { conclusion: gate.conclusion, blockerCodes: gate.blockers.map((blocker) => blocker.code) },
    holdout: holdout ?? null,
    clock: clock ?? null,
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
