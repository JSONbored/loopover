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
 * A CI-completion burst's window (#10127). Same 45s as a push, and for the same structural reason: a key with no
 * window coalesces nothing. Deliberately under CI_COALESCE_WINDOW_SECONDS (60s, processors.ts) so the downstream
 * per-PR re-review throttle stays the outer bound rather than being pre-empted by this one.
 */
const CI_COMPLETION_QUIET_WINDOW_SECONDS = 45;

/**
 * Label and review-surface bursts (#10127). Shorter than the CI window because both carry a human in the loop --
 * a maintainer removing a hold label expects the gate to notice promptly -- while still being long enough to
 * collapse a same-batch burst, which is what these actually produce (the Orb's relay drains on a fixed interval,
 * so a batch's events arrive within milliseconds of each other).
 */
const SURFACE_COALESCE_QUIET_WINDOW_SECONDS = 15;

/**
 * The delay to enqueue this delivery with.
 *
 * On a queue that coalesces (self-host pg/sqlite, which is where the ORB runs) this is what CREATES the window:
 * without a delay the first delivery is claimed immediately and later siblings find no pending row to merge into.
 * On Cloudflare Queues, which has no job_key coalescing, it is a plain deferral and nothing more -- correct, just
 * not a saving.
 *
 * #10127: this used to return non-zero for a push and ZERO for everything else, which made every other key
 * `githubWebhookCoalesceKey` computes inert -- they were derived, attached to the job, and could never merge into
 * anything. The Orb showed the cost: 1,727 `check_suite.completed` deliveries in a day and a half, and 2.98
 * decision records per distinct head SHA, each repeat buying a full prologue and a fresh gate pass over state
 * that had not changed.
 *
 * Derived from the SAME plan as the key, so a family can no longer have one without the other. That coupling is
 * the actual fix; the numbers are just tuning.
 */
export function githubWebhookCoalesceDelaySeconds(eventName: string, payload: GitHubWebhookPayload): number {
  return planGithubWebhookCoalesce(eventName, payload)?.quietWindowSeconds ?? 0;
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

/** One coalescable family: the job key siblings merge on, and the quiet window that lets them.
 *
 *  #10127: these two used to be computed by separate functions and drifted immediately -- four of the five
 *  families had a key and no window, so they never coalesced. Returning both together makes that state
 *  unrepresentable: adding a family means naming its window, because the type demands one. */
type WebhookCoalescePlan = { key: string; quietWindowSeconds: number };

export function githubWebhookCoalesceKey(
  eventName: string,
  payload: GitHubWebhookPayload,
): string | null {
  return planGithubWebhookCoalesce(eventName, payload)?.key ?? null;
}

function planGithubWebhookCoalesce(
  eventName: string,
  payload: GitHubWebhookPayload,
): WebhookCoalescePlan | null {
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
    // Interchangeable by construction: whichever delivery wins the race re-fetches the SAME already-settled CI
    // state, so collapsing a suite-completion burst loses nothing. The highest-volume family on the Orb by an
    // order of magnitude, and the reason #10127 exists.
    return {
      key: `github-webhook:ci-completed:${repo}@${headSha}${pullNumbers ? `#${pullNumbers}` : ""}`,
      quietWindowSeconds: CI_COMPLETION_QUIET_WINDOW_SECONDS,
    };
  }
  if (eventName === "pull_request" && isCoalescablePullRequestAction(action)) {
    const pr =
      normalizedNumber(payload.pull_request?.number) ??
      normalizedNumber((payload as { number?: unknown }).number);
    if (pr === null) return null;
    // #9479: a push is keyed on the PR alone, so the NEXT push collapses into it. See PUSH_COALESCE_ACTION.
    if (action === PUSH_COALESCE_ACTION) {
      return { key: `github-webhook:pr-push:${repo}#${pr}`, quietWindowSeconds: PUSH_COALESCE_QUIET_WINDOW_SECONDS };
    }
    const headSha = normalizedSha(payload.pull_request?.head?.sha);
    // Window deliberately ZERO, unlike every other family here (#10127). These are LIFECYCLE transitions --
    // opened, reopened, ready_for_review -- each of which happens once and starts the clock a contributor is
    // waiting on. They are keyed so a genuine same-instant duplicate still collapses, but delaying a PR's first
    // review to save a redelivery would trade a real cost (time-to-first-verdict) for an imaginary one: at 203
    // `opened` deliveries in a day and a half these are not a burst source in the first place.
    return {
      key: `github-webhook:pr-refresh:${repo}#${pr}${headSha ? `@${headSha}` : ""}`,
      quietWindowSeconds: 0,
    };
  }
  if (eventName === "pull_request" && COALESCABLE_PULL_REQUEST_LABEL_ACTIONS.has(action)) {
    const pr =
      normalizedNumber(payload.pull_request?.number) ??
      normalizedNumber((payload as { number?: unknown }).number);
    // The bot's OWN disposition-label writes come straight back as deliveries here
    // (shouldProcessPullRequestPublicSurface treats a disposition label as a re-sync trigger), so a pass that
    // adds a label and clears a stale sibling bought two full re-evaluations of state it had just written.
    return pr !== null
      ? { key: `github-webhook:pr-label:${repo}#${pr}`, quietWindowSeconds: SURFACE_COALESCE_QUIET_WINDOW_SECONDS }
      : null;
  }
  const reviewSurfaceActions = REVIEW_SURFACE_ACTIONS_BY_EVENT[eventName];
  if (reviewSurfaceActions?.has(action)) {
    const pr = normalizedNumber(payload.pull_request?.number);
    const headSha = normalizedSha(payload.pull_request?.head?.sha);
    // Payload-interchangeable within a family (see REVIEW_SURFACE_ACTIONS_BY_EVENT), and a review submission
    // routinely lands with several comment/thread deliveries in the same instant.
    return pr !== null
      ? {
          key: `github-webhook:${eventName}:${repo}#${pr}${headSha ? `@${headSha}` : ""}`,
          quietWindowSeconds: SURFACE_COALESCE_QUIET_WINDOW_SECONDS,
        }
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
