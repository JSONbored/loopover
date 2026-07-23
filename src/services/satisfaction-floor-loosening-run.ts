// IO orchestration for the backtest-gated satisfaction-floor loosening (#8121 narrow start) — the
// "separate, I/O-touching slice" satisfaction-floor-loosening.ts leaves to its caller, mirroring
// threshold-backtest-run.ts's identical split. Three responsibilities:
//   1. read the live floor override (system_flags, migration 0054 — the same operational-flag table the
//      auto-tune circuit breakers use, so no new storage surface);
//   2. evaluate a loosening against the rule's real recorded history (SignalStore → corpus → pure core);
//   3. apply an approved proposal: write the override + a calibration audit event.
//
// The ENTIRE apply path is flag-gated on env.SATISFACTION_FLOOR_AUTOTUNE_ENABLED (wrangler var, unset/false
// by default), so a deploy without the flag is behavior-identical — #8121's Boundaries demand no autonomous
// config change without the explicit opt-in. Direction is enforced here AGAIN (proposed < current, ≥ hard
// minimum) on top of the evaluator's own guarantee: the write path must be independently incapable of
// tightening-disguised-as-loosening or of sailing past the safety minimum, whatever its input claims.
import { buildBacktestCorpus } from "@loopover/engine";
import { createSignalStore } from "../review/signal-tracking-wire";
import { recordAuditEvent } from "../db/repositories";
import {
  evaluateSatisfactionFloorLoosening,
  SATISFACTION_FLOOR_HARD_MINIMUM,
  SATISFACTION_FLOOR_RULE_ID,
  type SatisfactionFloorLooseningProposal,
} from "./satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "./linked-issue-satisfaction";

export const SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY = "satisfaction_floor_override";
export const SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE = "calibration.satisfaction_floor_loosened";
const CORPUS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000; // mirrors threshold-backtest-run's 90-day window

/** Truthy-string env flag, matching the repo's flag convention (mirrors outcomes-wire's flagTruthy). */
export function isSatisfactionFloorAutotuneEnabled(env: Env): boolean {
  const value = (env.SATISFACTION_FLOOR_AUTOTUNE_ENABLED ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/**
 * Read the live floor override. Returns null (caller uses the shipped default) when: the autotune flag is
 * off (an operator turning the feature off instantly restores the shipped floor, no cleanup required), no
 * override row exists, or the stored value fails validation — an override may only ever sit BELOW the
 * shipped floor and AT/ABOVE the hard minimum, so a corrupted/hand-edited row can never tighten the floor
 * or loosen it past safety. Fail-safe null on any DB error (the shipped default is always the fallback).
 */
export async function getSatisfactionFloorOverride(env: Env): Promise<number | null> {
  if (!isSatisfactionFloorAutotuneEnabled(env)) return null;
  try {
    const row = await env.DB.prepare("SELECT value FROM system_flags WHERE key = ?")
      .bind(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY)
      .first<{ value: string }>();
    if (!row) return null;
    const parsed = Number(row.value);
    if (!Number.isFinite(parsed) || parsed >= LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR || parsed < SATISFACTION_FLOOR_HARD_MINIMUM) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type SatisfactionFloorLooseningRunResult =
  | { applied: false; reason: "flag_off" | "no_proposal" | "already_applied" }
  | { applied: true; proposal: SatisfactionFloorLooseningProposal };

/**
 * Evaluate and (when justified) apply a backtest-gated loosening of the satisfaction floor. The current
 * floor is the live override when one exists (so repeated runs evaluate from where the system actually is,
 * stepping at most one candidate per run, and can never oscillate upward). Persists the new override plus a
 * `calibration.satisfaction_floor_loosened` audit event carrying both split comparisons — the same
 * structured evidence trail every other calibration write in epic #8082 leaves. Audit write is best-effort;
 * the override write is NOT (an unrecorded floor change would be worse than no change, so a failed flag
 * write aborts by throwing to the caller — the internal route surfaces it as a 500).
 */
export async function runSatisfactionFloorLoosening(env: Env, nowMs: number = Date.now()): Promise<SatisfactionFloorLooseningRunResult> {
  if (!isSatisfactionFloorAutotuneEnabled(env)) return { applied: false, reason: "flag_off" };

  const currentFloor = (await getSatisfactionFloorOverride(env)) ?? LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR;
  if (currentFloor <= SATISFACTION_FLOOR_HARD_MINIMUM) return { applied: false, reason: "already_applied" };

  const { fired, overrides } = await createSignalStore(env).queryRuleHistory(SATISFACTION_FLOOR_RULE_ID, nowMs - CORPUS_LOOKBACK_MS);
  const cases = buildBacktestCorpus(SATISFACTION_FLOOR_RULE_ID, fired, overrides);
  const proposal = evaluateSatisfactionFloorLoosening(cases, currentFloor);
  if (!proposal) return { applied: false, reason: "no_proposal" };
  // Defense in depth: the write path independently refuses anything that isn't a strict, bounded loosening.
  if (proposal.proposedFloor >= currentFloor || proposal.proposedFloor < SATISFACTION_FLOOR_HARD_MINIMUM) {
    return { applied: false, reason: "no_proposal" };
  }

  await env.DB.prepare(
    "INSERT INTO system_flags (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(SATISFACTION_FLOOR_OVERRIDE_FLAG_KEY, String(proposal.proposedFloor))
    .run();

  await recordAuditEvent(env, {
    eventType: SATISFACTION_FLOOR_LOOSENING_EVENT_TYPE,
    actor: "loopover",
    targetKey: SATISFACTION_FLOOR_RULE_ID,
    outcome: "completed",
    detail: `satisfaction confidence floor loosened ${proposal.currentFloor} -> ${proposal.proposedFloor} (backtest-gated, visible improved + held-out non-regressed)`,
    metadata: { proposal },
  }).catch(() => undefined);

  return { applied: true, proposal };
}

/**
 * The cron-tick wrapper (#8158): one loosening evaluation, failing SAFE (a thrown evaluation is logged and
 * swallowed — the queue consumer must never poison-pill on telemetry work). An APPLIED loosening emits ONE
 * structured error-level alert — the same Workers-Logs + Sentry notify path runOpsAlerts documents (the
 * `ev` sub-field keeps distinct rules from collapsing into one Sentry issue) — and by construction cannot
 * re-alert on later ticks: the next evaluation starts from the already-loosened floor and returns
 * no_proposal until the corpus justifies another step.
 */
export async function runScheduledSatisfactionFloorLoosening(env: Env): Promise<SatisfactionFloorLooseningRunResult | null> {
  try {
    const result = await runSatisfactionFloorLoosening(env);
    if (result.applied) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "satisfaction_floor_loosened",
          ev: SATISFACTION_FLOOR_RULE_ID,
          at: new Date().toISOString(),
          currentFloor: result.proposal.currentFloor,
          proposedFloor: result.proposal.proposedFloor,
          visibleCases: result.proposal.visibleCases,
          heldOutCases: result.proposal.heldOutCases,
        }),
      );
    }
    return result;
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "satisfaction_floor_loosening_tick_failed", error: error instanceof Error ? error.message : "unknown error" }));
    return null;
  }
}
