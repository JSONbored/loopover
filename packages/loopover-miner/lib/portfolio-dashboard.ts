// Read-only portfolio-queue dashboard (#4287). Aggregates the miner's OWN local portfolio-queue backlog
// (packages/loopover-miner/lib/portfolio-queue.js) into summary stats — counts by status globally and per repo,
// plus the oldest queued item's age. Same three-layer shape as manage-status.js (pure collect → pure render → thin
// CLI glue), but scoped to the backlog/queue rather than per-PR manage state. 100% client-side, read-only — it never
// mutates queue state and never gates or enforces anything.
//
// The extension-panel half named in the issue is a forward dependency, not delivered here: the miner's queue is a
// local SQLite file with no local-reachable channel a GitHub-page content script can read today. The pure
// collector below is factored so it is directly reusable once such a channel exists.

import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";

const QUEUE_STATUS_KEYS = ["queued", "in_progress", "done"] as const;
type QueueStatusKey = (typeof QUEUE_STATUS_KEYS)[number];

export interface PortfolioRepoSummary {
  apiBaseUrl: string;
  repoFullName: string;
  byStatus: { queued: number; in_progress: number; done: number };
  total: number;
}

export interface PortfolioDashboardSummary {
  total: number;
  byStatus: { queued: number; in_progress: number; done: number };
  repos: PortfolioRepoSummary[];
  oldestQueuedAgeMs: number | null;
}

export interface PortfolioDashboardSources {
  portfolioQueue: { listQueue(repoFullName?: string | null): unknown[] };
}

type QueueEntryLike = {
  status?: unknown;
  repoFullName?: unknown;
  apiBaseUrl?: unknown;
  enqueuedAt?: unknown;
};

function emptyCounts(): { queued: number; in_progress: number; done: number } {
  return { queued: 0, in_progress: 0, done: 0 };
}

function isQueueStatusKey(status: unknown): status is QueueStatusKey {
  return typeof status === "string" && (QUEUE_STATUS_KEYS as readonly string[]).includes(status);
}

/**
 * Pure aggregator over an injected portfolio-queue store (mirrors manage-status.js's `collectManageStatus`).
 * Read-only. Returns global + per-repo status counts and, when a clock is supplied via `options.nowMs`, the age in
 * ms of the oldest still-`queued` item (null when no clock is given or nothing is queued).
 */
export function collectPortfolioDashboard(
  sources: PortfolioDashboardSources,
  options: { nowMs?: number } = {},
): PortfolioDashboardSummary {
  const portfolioQueue = sources?.portfolioQueue;
  if (!portfolioQueue || typeof portfolioQueue.listQueue !== "function") throw new Error("invalid_portfolio_queue");
  const nowMs = Number.isFinite(options.nowMs) ? (options.nowMs as number) : null;

  const byStatus = emptyCounts();
  const perRepo = new Map<string, PortfolioRepoSummary>();
  let total = 0;
  let oldestQueuedMs: number | null = null;

  for (const raw of portfolioQueue.listQueue(null)) {
    const entry = raw as QueueEntryLike;
    const status = entry?.status;
    if (!isQueueStatusKey(status)) continue;
    const repoFullName = typeof entry.repoFullName === "string" ? entry.repoFullName : "";
    // #7225: key per-repo backlogs by (apiBaseUrl, repoFullName) so two forge hosts sharing a repo name keep
    // independent counts instead of silently merging. The composite map key uses "\n" — never valid in either
    // component — so distinct (host, repo) pairs can never collide.
    const apiBaseUrl = typeof entry.apiBaseUrl === "string" ? entry.apiBaseUrl : "";
    total += 1;
    byStatus[status] += 1;
    const key = `${apiBaseUrl}\n${repoFullName}`;
    let repo = perRepo.get(key);
    if (!repo) {
      repo = { apiBaseUrl, repoFullName, byStatus: emptyCounts(), total: 0 };
      perRepo.set(key, repo);
    }
    repo.byStatus[status] += 1;
    repo.total += 1;
    if (status === "queued") {
      const ms = Date.parse(String(entry.enqueuedAt));
      if (Number.isFinite(ms) && (oldestQueuedMs === null || ms < oldestQueuedMs)) oldestQueuedMs = ms;
    }
  }

  const repos = [...perRepo.values()].sort(
    (left, right) =>
      left.repoFullName.localeCompare(right.repoFullName) || left.apiBaseUrl.localeCompare(right.apiBaseUrl),
  );
  const oldestQueuedAgeMs = nowMs !== null && oldestQueuedMs !== null ? Math.max(0, nowMs - oldestQueuedMs) : null;
  return { total, byStatus, repos, oldestQueuedAgeMs };
}

/** Plain-text render of a dashboard summary (mirrors manage-status.js's `renderManageStatusTable`). */
export function renderPortfolioDashboardTable(summary: PortfolioDashboardSummary | null | undefined): string {
  if (!summary || summary.total === 0) return "portfolio queue is empty";
  const age =
    summary.oldestQueuedAgeMs !== null ? `  oldest-queued: ${Math.round(summary.oldestQueuedAgeMs / 60000)}m` : "";
  const header = [
    "repo".padEnd(28),
    "host".padEnd(30),
    "queued".padStart(7),
    "in_prog".padStart(8),
    "done".padStart(6),
    "total".padStart(6),
  ].join(" ");
  const lines = summary.repos.map((repo) =>
    [
      repo.repoFullName.padEnd(28),
      String(repo.apiBaseUrl).padEnd(30),
      String(repo.byStatus.queued).padStart(7),
      String(repo.byStatus.in_progress).padStart(8),
      String(repo.byStatus.done).padStart(6),
      String(repo.total).padStart(6),
    ].join(" "),
  );
  return [
    `total: ${summary.total}  queued: ${summary.byStatus.queued}  in_progress: ${summary.byStatus.in_progress}  done: ${summary.byStatus.done}${age}`,
    "",
    header,
    ...lines,
  ].join("\n");
}

export function parsePortfolioDashboardArgs(args: string[] = []): { json: boolean } | { error: string } {
  for (const token of args) {
    if (token === "--json") continue;
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    return { error: "Usage: loopover-miner queue dashboard [--json]" };
  }
  return { json: args.includes("--json") };
}

/** CLI glue for `loopover-miner queue dashboard [--json]` (mirrors manage-status.js's `runManageStatus`). */
export function runPortfolioDashboard(
  args: string[] = [],
  options: {
    initPortfolioQueue?: () => { listQueue(repoFullName: string | null): unknown[]; close(): void };
    nowMs?: number;
  } = {},
): number {
  const parsed = parsePortfolioDashboardArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }
  const ownsQueue = options.initPortfolioQueue === undefined;
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  try {
    const summary = collectPortfolioDashboard(
      { portfolioQueue },
      { nowMs: Number.isFinite(options.nowMs) ? (options.nowMs as number) : Date.now() },
    );
    console.log(parsed.json ? JSON.stringify(summary, null, 2) : renderPortfolioDashboardTable(summary));
    return 0;
  } finally {
    if (ownsQueue) portfolioQueue.close();
  }
}
