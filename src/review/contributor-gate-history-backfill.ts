// Backfill missing contributor_gate_history rows (#fairness-analytics) -- contributor_gate_history (migration
// 0126) only started recording on the day it shipped, so every gate decision made BEFORE that has no per-login
// row, even though review_audit (actor-login-free by design) already has the decision itself. This reconstructs
// the missing rows by joining review_audit's gate_decision rows to pull_requests.author_login (present since
// migration 0001) via the SAME target_id format both tables share (`repo#pr`).
//
// Modeled on backfillRegisteredRepositories's shape (src/github/backfill.ts): a plain env-driven async function,
// a typed result the caller can log/report, and idempotent by construction -- the NOT EXISTS check below means a
// re-run only ever processes rows the LIVE write path (recordContributorGateDecision) and a prior backfill run
// haven't already covered, so calling this repeatedly (a queue retry, a manual re-trigger) is always safe.
//
// SCOPE: inherits contributor-gate-eval.ts's design note -- the rows this writes are the SAME
// contributor_gate_history table, never rendered on any public surface, never wired into exportOrbBatch.
//
// TIMESTAMP FIDELITY: each reconstructed row's created_at is the ORIGINAL review_audit row's created_at, not
// the time this backfill ran -- computeContributorGateEval's `created_at >= ?` rolling-window filter (and any
// day-bucketed view) needs the true historical date to age rows out correctly.

import { errorMessage } from "../utils/json";

export interface ContributorGateHistoryBackfillResult {
  /** review_audit gate_decision rows examined in this batch (bounded by opts.limit). */
  scanned: number;
  /** New contributor_gate_history rows written. */
  inserted: number;
  /** A candidate row's PR had no resolvable author_login (deleted account, bot, or the PR itself was never
   *  synced) -- there is no meaningful per-actor row to write without one, matching
   *  recordContributorGateDecision's own live-path behavior for a missing login. */
  skippedNoAuthor: number;
  /** True when this batch hit opts.limit -- more unbackfilled rows may remain; call again to continue. */
  hasMore: boolean;
}

const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCH_LIMIT = 5000;

/**
 * Backfill one batch of missing contributor_gate_history rows. Fail-safe: a read error returns an all-zero,
 * hasMore:false result rather than throwing (matches computeGateEval/computeFleetAnalytics's own stance) --
 * this is a maintenance operation invoked from an internal route, not a step in a live request path, but a
 * partial-batch failure should still surface as "did nothing" rather than crash the caller.
 */
export async function backfillContributorGateHistory(env: Env, opts: { limit?: number } = {}): Promise<ContributorGateHistoryBackfillResult> {
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.min(opts.limit as number, MAX_BATCH_LIMIT) : DEFAULT_BATCH_LIMIT;

  type Candidate = { project: string; targetId: string; decision: string; headSha: string | null; source: string; authorLogin: string | null; createdAt: string };
  let candidates: Candidate[] = [];
  try {
    const res = await env.DB.prepare(
      `SELECT ra.project AS project, ra.target_id AS targetId, ra.decision AS decision, ra.head_sha AS headSha,
              ra.source AS source, pr.author_login AS authorLogin, ra.created_at AS createdAt
         FROM review_audit ra
         LEFT JOIN pull_requests pr
           ON pr.repo_full_name = ra.project
          AND pr.number = CAST(substr(ra.target_id, instr(ra.target_id, '#') + 1) AS INTEGER)
        WHERE ra.event_type = 'gate_decision' AND ra.decision IS NOT NULL AND instr(ra.target_id, '#') > 0
          AND NOT EXISTS (
            SELECT 1 FROM contributor_gate_history cgh
             WHERE cgh.project = ra.project AND cgh.target_id = ra.target_id AND cgh.source = ra.source
               AND (cgh.head_sha = ra.head_sha OR (cgh.head_sha IS NULL AND ra.head_sha IS NULL))
          )
        ORDER BY ra.created_at ASC
        LIMIT ?`,
    )
      .bind(limit + 1) // fetch one extra to detect whether more remain, without a separate COUNT query
      .all<Candidate>();
    candidates = res.results ?? [];
  } catch (error) {
    console.warn(JSON.stringify({ event: "contributor_gate_history_backfill_read_error", message: errorMessage(error).slice(0, 200) }));
    return { scanned: 0, inserted: 0, skippedNoAuthor: 0, hasMore: false };
  }

  const hasMore = candidates.length > limit;
  const batch = hasMore ? candidates.slice(0, limit) : candidates;

  let inserted = 0;
  let skippedNoAuthor = 0;
  for (const c of batch) {
    const login = c.authorLogin?.trim();
    if (!login) {
      skippedNoAuthor += 1;
      continue;
    }
    try {
      const result = await env.DB.prepare(
        `INSERT INTO contributor_gate_history (id, login, source, project, target_id, decision, head_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
        .bind(`contrib:${login}:${c.source}:${c.targetId}@${c.headSha ?? "none"}`, login, c.source, c.project, c.targetId, c.decision, c.headSha, c.createdAt)
        .run();
      if (result.meta.changes > 0) inserted += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "contributor_gate_history_backfill_write_error", project: c.project, targetId: c.targetId, message: errorMessage(error).slice(0, 200) }));
    }
  }

  return { scanned: batch.length, inserted, skippedNoAuthor, hasMore };
}
