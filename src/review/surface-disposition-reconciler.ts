import { recordAuditEvent } from "../db/repositories";
import { errorMessage } from "../utils/json";

/**
 * #8997 — rescue a PR left wearing a decisive panel with no matching disposition.
 *
 * A deploy restart (SIGTERM, no drain) can kill a pass at the worst possible cut point: after the public-surface
 * publish commits (panel comment, gate check-run, CI aggregate all reflect the current head) but before
 * `maybeRunAgentMaintenance` ever claims its per-PR actuation lock for that head. The confirmed live shape
 * (#8965, 2026-07-26): a red-CI panel published at 14:55:24Z from the dying container, and the matching close
 * only executed at 15:07:53Z — ~12 minutes later, purely because an UNRELATED later sweep tick happened to
 * re-run the whole pass from scratch. The regular outage-repair priority check
 * (`surfaceRepairPriorityPullNumbers`, processors.ts) cannot see this: it flags a STALE surface
 * (`lastPublishedSurfaceSha !== headSha`), and this incident's surface is not stale — it published successfully
 * right before the kill. From that check's point of view the PR already looks healthy.
 *
 * This scan is the missing half: it looks for the disposition side directly. `maybeRunAgentMaintenance` records
 * a durable marker (`DISPOSITION_CONSIDERED_EVENT_TYPE`, processors.ts) the moment it claims the actuation lock
 * for a head — i.e. the moment a real disposition attempt begins. A PR whose surface is current for its head but
 * carries no such marker never got that far, for whatever reason (a restart being the confirmed one; a thrown
 * error before the claim is another). Re-enqueuing a regate is cheap and safe either way: `agent-regate-pr`
 * re-derives everything from live state, and a PR that in fact already has a real disposition in flight is
 * simply denied by the SAME actuation lock this scan is checking for, exactly as any other contending pass would
 * be (#9013's per-PR mutex).
 *
 * Deliberately independent of surfaceRepairPriorityPullNumbers rather than folded into it: that function's
 * return value directly drives the regular sweep's staleness-ordered fan-out and is asserted against by a large
 * existing test surface (dispatch shape, ordering, backlog-restriction semantics). Riding the SAME sweep tick as
 * its own bounded scan — mirroring reconcileMissingPrOutcomes/sweepStrandedPendingClosures (#9026/#9031) — closes
 * the identical gap without touching that already-tested surface at all.
 */

export const DISPOSITION_CONSIDERED_EVENT_TYPE = "agent.maintenance.disposition_considered";

/** How far back to look. Bounded so the scan stays cheap on every tick; a surface-without-disposition PR older
 *  than this has almost certainly been superseded by a later commit or resolved by a human already. */
export const SURFACE_DISPOSITION_RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Cap per run, mirroring the other bounded repair scans on this same sweep tick. */
export const SURFACE_DISPOSITION_RECONCILE_LIMIT = 200;

export type SurfaceDispositionReconcileResult = { scanned: number; requeued: number };

/**
 * Find open PRs with a current published surface but no disposition marker for that exact head, and re-enqueue
 * an `agent-regate-pr` job for each. Best-effort throughout: a repair pass that can itself break the tick it
 * rides on is worse than the gap it exists to close.
 */
export async function reconcileSurfaceWithoutDisposition(env: Env, nowMs: number = Date.now()): Promise<SurfaceDispositionReconcileResult> {
  const since = new Date(nowMs - SURFACE_DISPOSITION_RECONCILE_LOOKBACK_MS).toISOString();
  let rows: Array<{ repoFullName: string; number: number; installationId: number; headSha: string; createdAt: string }> = [];
  try {
    const result = await env.DB.prepare(
      `SELECT pr.repo_full_name AS repoFullName, pr.number AS number, repo.installation_id AS installationId, pr.head_sha AS headSha, pr.created_at AS createdAt
         FROM pull_requests AS pr
         JOIN repositories AS repo ON repo.full_name = pr.repo_full_name
        WHERE pr.state = 'open'
          AND pr.head_sha IS NOT NULL
          AND pr.last_published_surface_sha = pr.head_sha
          AND pr.updated_at >= ?1
          AND repo.installation_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM audit_events AS disposition
             WHERE disposition.target_key = pr.repo_full_name || '#' || pr.number || '#' || pr.head_sha
               AND disposition.event_type = ?2
          )
        ORDER BY pr.updated_at
        LIMIT ?3`,
    )
      .bind(since, DISPOSITION_CONSIDERED_EVENT_TYPE, SURFACE_DISPOSITION_RECONCILE_LIMIT)
      .all<{ repoFullName: string; number: number; installationId: number; headSha: string; createdAt: string }>();
    rows = result.results ?? [];
  } catch (error) {
    console.warn(JSON.stringify({ level: "warn", event: "surface_disposition_reconcile_scan_failed", message: errorMessage(error).slice(0, 160) }));
    return { scanned: 0, requeued: 0 };
  }

  let requeued = 0;
  for (const row of rows) {
    const sent = await env.JOBS.send({
      type: "agent-regate-pr",
      deliveryId: `surface-without-disposition:${row.repoFullName}#${row.number}#${row.headSha}`,
      repoFullName: row.repoFullName,
      prNumber: row.number,
      installationId: row.installationId,
      // #9499: without prCreatedAt the claim sort key falls back to a legacy base that sorts ahead of every
      // real PR, so this repair scan silently preempted genuinely older contributor work. Unconditional --
      // pull_requests.created_at is NOT NULL, so there is no absent case to guard.
      prCreatedAt: row.createdAt,
    })
      .then(() => true)
      .catch(() => false);
    if (!sent) continue;
    requeued += 1;
    await recordAuditEvent(env, {
      eventType: "agent.sweep.surface_without_disposition",
      actor: "loopover",
      targetKey: `${row.repoFullName}#${row.number}`,
      outcome: "queued",
      detail: "published surface has no matching disposition for this head; re-gating to close the gap",
      metadata: { repoFullName: row.repoFullName, pullNumber: row.number, headSha: row.headSha },
    }).catch(() => undefined);
  }
  return { scanned: rows.length, requeued };
}
