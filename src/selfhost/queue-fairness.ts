// Claim-time backlog-vs-fresh-intake fairness (#selfhost-backlog-convergence). Without this, every foreground
// job (priority >= FOREGROUND_QUEUE_PRIORITY_FLOOR) is claimed in plain `priority DESC, run_after, id` order —
// so a `github-webhook` PR-refresh row (priority 10) ALWAYS wins over an `agent-regate-pr` backlog-convergence
// row (priority 9), no matter how old the backlog work is. A sustained burst of fresh webhook traffic can then
// starve backlog-convergence work indefinitely, even though both are foreground-priority. These pure helpers
// decide, at claim time, which of the two classified lanes to PREFER this cycle and (for the backlog lane)
// which repo to serve next — the queue backends (sqlite-queue.ts / pg-queue.ts) consult them before falling
// back to the existing unscoped foreground claim. Pure + deterministic; no wall-clock, no hidden state.

export type ForegroundLane = "backlog" | "fresh" | null;

const FRESH_PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

// The prefix a backlog-convergence-sourced `agent-regate-pr` job's deliveryId carries (see
// selfhost/backlog-convergence.ts) — distinct from sweep-originated (`regate-sweep:`) or manual
// (`manual-regate:`) origins, which are intentionally left unclassified (lane `null`): their relative
// ordering against everything else is unaffected by this fairness mechanism.
const BACKLOG_CONVERGENCE_DELIVERY_PREFIX = "backlog-convergence:";

/**
 * Classify a job's foreground fairness lane from its type + raw payload — `"fresh"` for a webhook-driven PR
 * open/reopen/synchronize/ready-for-review event, `"backlog"` for a backlog-convergence-sourced re-gate job,
 * `null` for everything else (untouched by this mechanism; falls through to plain priority-ordered claiming).
 * A malformed payload classifies as `null` rather than throwing — fail-closed, matching queue-common.ts's
 * `jobPriority`/`jobCoalesceKey` style. Pure.
 */
export function foregroundLaneForJob(type: string, payload: string): ForegroundLane {
  try {
    if (type === "github-webhook") {
      const message = JSON.parse(payload) as {
        eventName?: unknown;
        payload?: { action?: unknown } | null;
      };
      const eventName = typeof message.eventName === "string" ? message.eventName : "";
      const action = typeof message.payload?.action === "string" ? message.payload.action : "";
      return eventName === "pull_request" && FRESH_PULL_REQUEST_ACTIONS.has(action) ? "fresh" : null;
    }
    if (type === "agent-regate-pr") {
      const message = JSON.parse(payload) as { deliveryId?: unknown };
      const deliveryId = typeof message.deliveryId === "string" ? message.deliveryId : "";
      return deliveryId.startsWith(BACKLOG_CONVERGENCE_DELIVERY_PREFIX) ? "backlog" : null;
    }
    return null;
  } catch {
    return null;
  }
}

export type ForegroundLaneRatio = { backlogPer: number; freshPer: number };

// 3 backlog claims for every 1 fresh claim (suggested by the operator report, not a fixed law): heavily favors
// draining old backlog while still guaranteeing fresh PR events a claim slot at least 1-in-4 cycles, never
// fully starved.
export const DEFAULT_FOREGROUND_LANE_RATIO: ForegroundLaneRatio = { backlogPer: 3, freshPer: 1 };

/**
 * Which lane a claim at this point in the sequence should prefer: a fixed repeating pattern indexed by
 * `sequence % windowSize` — no wall-clock, so the SAME sequence value always yields the SAME lane. `sequence`
 * is a monotonically-advancing counter the queue backend bumps on every foreground claim attempt (hit or miss),
 * so the cycle always progresses even when the preferred lane happens to be empty this turn (the caller falls
 * back to an unscoped claim on a miss — see sqlite-queue.ts / pg-queue.ts). Pure.
 */
export function nextForegroundLane(
  sequence: number,
  ratio: ForegroundLaneRatio = DEFAULT_FOREGROUND_LANE_RATIO,
): "backlog" | "fresh" {
  const windowSize = ratio.backlogPer + ratio.freshPer;
  return sequence % windowSize < ratio.backlogPer ? "backlog" : "fresh";
}

export type BacklogRepoCandidate = { repo: string; oldestPendingAgeMs: number };

/**
 * Per-repo round-robin for the backlog lane: pick the repo whose oldest pending backlog job is stalest,
 * EXCEPT when that repo was also the last one served — in that case, rotate to the next-stalest so a single
 * repo with a deep backlog cannot monopolize every backlog-lane claim and starve every other repo's backlog.
 * A `lastClaimedRepo` no longer present in `candidates` (its backlog fully drained since) falls back to the
 * stalest overall, same as a first-ever pick. Pure.
 */
export function pickBacklogRepo(candidates: readonly BacklogRepoCandidate[], lastClaimedRepo: string | null): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => b.oldestPendingAgeMs - a.oldestPendingAgeMs || a.repo.localeCompare(b.repo));
  // sorted.length is provably >0 past the early return above, so every index below is in bounds.
  const stalest = sorted[0] as BacklogRepoCandidate;
  if (!lastClaimedRepo) return stalest.repo;
  const lastIndex = sorted.findIndex((candidate) => candidate.repo === lastClaimedRepo);
  if (lastIndex === -1) return stalest.repo;
  return (sorted[(lastIndex + 1) % sorted.length] as BacklogRepoCandidate).repo;
}

const AGENT_REGATE_PR_JOB_KEY_PREFIX = "agent-regate-pr:";

/**
 * Derive per-repo backlog candidates from raw pending backlog-lane job rows (job_key + created_at), rather than
 * a repo-extracting SQL expression — keeps the string parsing in one pure, unit-testable place instead of
 * duplicated/diverging between the SQLite and Postgres claim queries. `job_key` for a backlog-convergence
 * `agent-regate-pr` row is always `agent-regate-pr:{repo}#{pr}` (queue-common.ts's `jobCoalesceKey`); a row with
 * no/malformed job_key is skipped (it cannot be attributed to a repo, so it cannot participate in the per-repo
 * round-robin — the unscoped fallback claim still picks it up normally). Pure.
 */
export function backlogRepoCandidatesFromJobKeys(
  rows: readonly { jobKey: string | null | undefined; createdAtMs: number }[],
  nowMs: number,
): BacklogRepoCandidate[] {
  const oldestAgeByRepo = new Map<string, number>();
  for (const row of rows) {
    if (!row.jobKey || !row.jobKey.startsWith(AGENT_REGATE_PR_JOB_KEY_PREFIX)) continue;
    const rest = row.jobKey.slice(AGENT_REGATE_PR_JOB_KEY_PREFIX.length);
    const hashIndex = rest.indexOf("#");
    const repo = hashIndex === -1 ? rest : rest.slice(0, hashIndex);
    if (!repo) continue;
    const ageMs = Math.max(0, nowMs - row.createdAtMs);
    const existingAge = oldestAgeByRepo.get(repo);
    if (existingAge === undefined || ageMs > existingAge) oldestAgeByRepo.set(repo, ageMs);
  }
  return [...oldestAgeByRepo.entries()].map(([repo, oldestPendingAgeMs]) => ({ repo, oldestPendingAgeMs }));
}
