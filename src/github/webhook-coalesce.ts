import type { GitHubWebhookPayload } from "../types";

// Kept in sync with PR_PUBLIC_SURFACE_ACTIONS (src/queue/processors.ts) minus "closed" (merge/close has its own
// non-coalesced handling): every action that can trigger a file refresh for the SAME PR+head should collapse a
// burst into one job, not one job per delivery (#audit-rate-headroom).
const COALESCABLE_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
]);

/**
 * #9479: `synchronize` -- a PUSH -- gets its own PR-scoped coalesce key and a trailing quiet window; every other
 * action above keeps the head-SHA-scoped key unchanged.
 *
 * Every dedup layer in the pipeline was keyed on the head SHA (this key, and the AI-review lock's
 * `...@${headSha}:${mode}`), which is exactly the wrong key for a force-push storm: each push MINTS a new SHA, so
 * five amend-and-repush cycles in a minute looked like five unrelated events and bought five full prologues
 * (file list, up to 96k chars of grounding fetch, RAG + impact-map embeddings, an enrichment POST) and five LLM
 * calls. Four of those five review heads no longer exist by the time their review lands. `skipStaleReviewOutput`
 * suppresses the stale COMMENT, but only after the spend; the `review burst` ops alert reports the storm without
 * throttling it.
 *
 * Dropping the SHA makes consecutive pushes collide, and the queue's coalesce keeps the LATEST payload while
 * extending `run_after` (`GREATEST(run_after, ...)` in pg-queue/sqlite-queue's enqueue) -- so a burst converges to
 * ONE job, at the last push plus the window, reviewing the head that actually survived.
 *
 * Deliberately a SEPARATE key from `pr-refresh` rather than simply dropping the SHA there. A shared PR-scoped key
 * would let a push swallow a still-pending `opened`/`ready_for_review` in the same window, since coalescing
 * overwrites the payload and only the last action survives -- trading a spend bug for a lost-lifecycle-event bug.
 */
const PUSH_COALESCE_ACTION = "synchronize";

/** How long to hold a push before reviewing it, so a re-push lands inside the same window and replaces it. Sized
 *  to match CI_COALESCE_WINDOW_SECONDS (processors.ts), the pipeline's existing burst window, and to comfortably
 *  cover a human amend-and-force-push cycle without adding meaningful latency to an ordinary single push -- which
 *  then waits on CI anyway. */
export const PUSH_COALESCE_QUIET_WINDOW_SECONDS = 45;

/**
 * The delay to enqueue this delivery with. Non-zero ONLY for a push, whose key above is built to coalesce.
 *
 * On a queue that coalesces (self-host pg/sqlite, which is where the ORB runs) this is what CREATES the window:
 * without a delay the first push is claimed immediately and later pushes find no pending row to merge into. On
 * Cloudflare Queues, which has no job_key coalescing, it is a plain 45s deferral of push-triggered reviews and
 * nothing more -- correct, just not a saving.
 */
export function githubWebhookCoalesceDelaySeconds(eventName: string, payload: GitHubWebhookPayload): number {
  return eventName === "pull_request" && payload.action === PUSH_COALESCE_ACTION ? PUSH_COALESCE_QUIET_WINDOW_SECONDS : 0;
}

// #selfhost-backlog-convergence: every "labeled"/"unlabeled" delivery re-syncs the PR row
// (upsertPullRequestFromGitHub) regardless of which specific label changed -- shouldProcessPullRequestPublicSurface
// (processors.ts) additionally runs the public-surface pipeline itself, but only when the changed label is a
// disposition label (#9059/#9171); coalescing here is orthogonal to that check and stays keyed on the PR alone,
// not the label name, since a same-PR burst is duplicate row-sync overhead either way and the queue keeps the
// LATEST payload on coalesce (see pg-queue's job_key UPDATE), so the disposition check downstream still sees
// whichever label change arrived last. A burst of label events for the same PR is safe to coalesce to one job
// (unlike issue-side labeled/unlabeled on a linked ISSUE, which has its OWN dedicated trailing-re-review
// coalescer in processors.ts specifically because an add-then-remove sequence there carries a genuinely
// different state).
const COALESCABLE_PULL_REQUEST_LABEL_ACTIONS = new Set(["labeled", "unlabeled"]);

// #selfhost-backlog-convergence: mirrors shouldProcessPullRequestPublicSurface's (processors.ts) own action
// allowlist for review comments/threads. Unlike `pull_request_review`, these events do not carry review-cache
// invalidation or changes-requested notification side effects, so only payload-interchangeable event families
// may coalesce with each other.
const REVIEW_SURFACE_ACTIONS_BY_EVENT: Record<string, ReadonlySet<string>> = {
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  pull_request_review_thread: new Set(["resolved", "unresolved"]),
};

export function githubWebhookCoalesceKey(
  eventName: string,
  payload: GitHubWebhookPayload,
): string | null {
  const action =
    typeof payload.action === "string" ? payload.action : "";
  const repo = normalizedRepo(payload.repository?.full_name);
  if (!repo) return null;
  if (
    (eventName === "check_suite" || eventName === "check_run") &&
    action === "completed"
  ) {
    const node = webhookNode(eventName, payload);
    const headSha = normalizedSha(
      node?.head_sha ??
        (eventName === "check_run" ? node?.check_suite?.head_sha : undefined),
    );
    if (!headSha) return null;
    const pullNumbers = (node?.pull_requests ?? [])
      .map((entry) => normalizedNumber(entry?.number))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)
      .join(",");
    return `github-webhook:ci-completed:${repo}@${headSha}${pullNumbers ? `#${pullNumbers}` : ""}`;
  }
  if (eventName === "pull_request" && isCoalescablePullRequestAction(action)) {
    const pr =
      normalizedNumber(payload.pull_request?.number) ??
      normalizedNumber((payload as { number?: unknown }).number);
    if (pr === null) return null;
    // #9479: a push is keyed on the PR alone, so the NEXT push collapses into it. See PUSH_COALESCE_ACTION.
    if (action === PUSH_COALESCE_ACTION) return `github-webhook:pr-push:${repo}#${pr}`;
    const headSha = normalizedSha(payload.pull_request?.head?.sha);
    return `github-webhook:pr-refresh:${repo}#${pr}${headSha ? `@${headSha}` : ""}`;
  }
  if (eventName === "pull_request" && COALESCABLE_PULL_REQUEST_LABEL_ACTIONS.has(action)) {
    const pr =
      normalizedNumber(payload.pull_request?.number) ??
      normalizedNumber((payload as { number?: unknown }).number);
    return pr !== null ? `github-webhook:pr-label:${repo}#${pr}` : null;
  }
  const reviewSurfaceActions = REVIEW_SURFACE_ACTIONS_BY_EVENT[eventName];
  if (reviewSurfaceActions?.has(action)) {
    const pr = normalizedNumber(payload.pull_request?.number);
    const headSha = normalizedSha(payload.pull_request?.head?.sha);
    return pr !== null
      ? `github-webhook:${eventName}:${repo}#${pr}${headSha ? `@${headSha}` : ""}`
      : null;
  }
  return null;
}

function webhookNode(
  eventName: string,
  payload: GitHubWebhookPayload,
):
  | {
      head_sha?: unknown;
      check_suite?: { head_sha?: unknown } | null;
      pull_requests?: Array<{ number?: unknown } | null> | null;
    }
  | undefined {
  const record = payload as Record<string, unknown>;
  return record[eventName] as
    | {
        head_sha?: unknown;
        check_suite?: { head_sha?: unknown } | null;
        pull_requests?: Array<{ number?: unknown } | null> | null;
      }
    | undefined;
}

function normalizedRepo(value: unknown): string | null {
  return typeof value === "string" && value.includes("/")
    ? value.trim().toLowerCase()
    : null;
}

function normalizedNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

function normalizedSha(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function isCoalescablePullRequestAction(action: string): boolean {
  return COALESCABLE_PULL_REQUEST_ACTIONS.has(action);
}
