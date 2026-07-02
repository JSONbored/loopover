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
    const headSha = normalizedSha(payload.pull_request?.head?.sha);
    return pr !== null
      ? `github-webhook:pr-refresh:${repo}#${pr}${headSha ? `@${headSha}` : ""}`
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
