// Read-only client for the local portfolio-queue API (#4306, richer per-repo detail added by #4846). The
// middleware now serves the SAME per-repo dashboard shape the CLI's `queue dashboard` command computes
// (packages/gittensory-miner/lib/portfolio-dashboard.js's collectPortfolioDashboard) instead of a narrower
// global-only aggregate, so the miner-ui and the CLI share one data path rather than maintaining two. It still
// never republishes raw queue identifiers or rank-derived priorities — only status counts, grouped by repo.

export const PORTFOLIO_QUEUE_API_PATH = "/api/portfolio-queue";

export const QUEUE_STATUSES = ["queued", "in_progress", "done"] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type QueueStatusCounts = Record<QueueStatus, number>;

export type PortfolioRepoSummary = {
  repoFullName: string;
  byStatus: QueueStatusCounts;
  total: number;
};

export type PortfolioQueueSummary = {
  total: number;
  byStatus: QueueStatusCounts;
  repos: PortfolioRepoSummary[];
  oldestQueuedAgeMs: number | null;
};

export type PortfolioQueueResult = { ok: true; summary: PortfolioQueueSummary } | { ok: false; error: string };

function isQueueStatusCounts(value: unknown): value is QueueStatusCounts {
  if (typeof value !== "object" || value === null) return false;
  const counts = value as Record<string, unknown>;
  return QUEUE_STATUSES.every((status) => typeof counts[status] === "number");
}

function isPortfolioRepoSummary(value: unknown): value is PortfolioRepoSummary {
  if (typeof value !== "object" || value === null) return false;
  const repo = value as Record<string, unknown>;
  return typeof repo.repoFullName === "string" && isQueueStatusCounts(repo.byStatus) && typeof repo.total === "number";
}

function isPortfolioQueueSummary(value: unknown): value is PortfolioQueueSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (
    typeof summary.total === "number" &&
    isQueueStatusCounts(summary.byStatus) &&
    Array.isArray(summary.repos) &&
    summary.repos.every(isPortfolioRepoSummary) &&
    (summary.oldestQueuedAgeMs === null || typeof summary.oldestQueuedAgeMs === "number")
  );
}

export const emptyPortfolioQueueSummary = (): PortfolioQueueSummary => ({
  total: 0,
  byStatus: { queued: 0, in_progress: 0, done: 0 },
  repos: [],
  oldestQueuedAgeMs: null,
});

/** Fetch the local queue summary; failures surface as a typed error result the view renders, never a crash. */
export async function fetchPortfolioQueue(fetchImpl: typeof fetch = fetch): Promise<PortfolioQueueResult> {
  try {
    const response = await fetchImpl(PORTFOLIO_QUEUE_API_PATH);
    if (!response.ok) return { ok: false, error: `local portfolio-queue API responded ${response.status}` };
    const payload: unknown = await response.json();
    const summary = (payload as { summary?: unknown }).summary;
    if (!isPortfolioQueueSummary(summary)) {
      return { ok: false, error: "local portfolio-queue API returned an unexpected payload shape" };
    }
    return { ok: true, summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local portfolio-queue API",
    };
  }
}
