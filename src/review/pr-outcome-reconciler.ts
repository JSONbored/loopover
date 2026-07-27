import { recordTerminalActionOutcome } from "./outcomes-wire";
import { errorMessage } from "../utils/json";

/**
 * #9026 — backfill `pr_outcome` rows that were never written.
 *
 * `pr_outcome` is the realized ground truth the fleet calibration export inner-joins `gate_decision` against, so
 * a PR missing one does not merely lose a data point: it vanishes from calibration entirely, contributing to
 * neither numerator nor denominator. It is written two ways, both in-process and both best-effort —
 * `recordTerminalActionOutcome` immediately after the bot's own merge/close mutation, and `recordPrOutcome` from
 * the inbound `pull_request.closed` webhook.
 *
 * Neither survives a kill at the wrong moment. A process that dies between `mergePullRequest`/`closePullRequest`
 * and the record call loses the direct write, and on the next pass the PR is already terminal so the planner
 * plans nothing and the write never fires. The webhook that would have caught it was delivered while the
 * container was down, and GitHub does not redeliver. Nothing scanned for the gap: the repair sweep only visits
 * OPEN PRs. #8823 narrowed the window; it did not close it.
 *
 * The rows this loses are not a random sample. A superseded close is by definition a wrong close, so the losses
 * skew toward the gate's mistakes and their absence biases published accuracy UPWARD — which is why this matters
 * more than ordinary telemetry loss, and why it is worth a reconciler rather than a wider window.
 *
 * Scoped to PRs that actually carry a `gate_decision`, because those are exactly the ones calibration reads; a
 * closed PR the gate never evaluated has no prediction to pair an outcome with. `recordTerminalActionOutcome` is
 * already idempotent, so a row that raced in between this scan and the write is a no-op.
 */

/** How far back to look. Long enough to cover a multi-day outage, bounded so the scan stays cheap on every
 *  run — anything older has already been exported and is beyond repair for the current calibration window. */
export const PR_OUTCOME_RECONCILE_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/** Cap per run. The scan is ordered oldest-first so a large backlog drains deterministically across runs
 *  instead of the same newest slice being retried forever. */
export const PR_OUTCOME_RECONCILE_LIMIT = 200;

export type PrOutcomeReconcileResult = { scanned: number; backfilled: number };

/**
 * Find terminal PRs with a gate decision but no recorded outcome, and write the outcome. Returns what it did so
 * the caller can log it. Best-effort throughout: this is a repair pass, and a repair pass that can itself break
 * the tick it runs on is worse than the gap it closes.
 */
export async function reconcileMissingPrOutcomes(env: Env, nowMs: number = Date.now()): Promise<PrOutcomeReconcileResult> {
  const since = new Date(nowMs - PR_OUTCOME_RECONCILE_LOOKBACK_MS).toISOString();
  let rows: Array<{ repoFullName: string; number: number; mergedAt: string | null }> = [];
  try {
    const result = await env.DB.prepare(
      `SELECT pr.repo_full_name AS repoFullName, pr.number AS number, pr.merged_at AS mergedAt
         FROM pull_requests AS pr
        WHERE pr.state != 'open'
          AND pr.updated_at >= ?1
          AND EXISTS (
            SELECT 1 FROM review_audit AS gate
             WHERE gate.target_id = pr.repo_full_name || '#' || pr.number
               AND gate.event_type = 'gate_decision'
          )
          AND NOT EXISTS (
            SELECT 1 FROM review_audit AS outcome
             WHERE outcome.target_id = pr.repo_full_name || '#' || pr.number
               AND outcome.event_type = 'pr_outcome'
          )
        ORDER BY pr.updated_at
        LIMIT ?2`,
    )
      .bind(since, PR_OUTCOME_RECONCILE_LIMIT)
      .all<{ repoFullName: string; number: number; mergedAt: string | null }>();
    rows = result.results ?? [];
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "pr_outcome_reconcile_scan_failed", message: errorMessage(error).slice(0, 160) }));
    return { scanned: 0, backfilled: 0 };
  }

  let backfilled = 0;
  for (const row of rows) {
    // `merged_at` is the authoritative signal, not the state string: GitHub reports a merged PR as `closed`
    // too, and recording a merge as a plain close would invert the very judgment calibration is scoring.
    const decision = row.mergedAt ? "merged" : "closed";
    try {
      await recordTerminalActionOutcome(env, row.repoFullName, row.number, decision);
      backfilled += 1;
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "pr_outcome_reconcile_write_failed",
          repo: row.repoFullName,
          pr: row.number,
          message: errorMessage(error).slice(0, 160),
        }),
      );
    }
  }
  return { scanned: rows.length, backfilled };
}
