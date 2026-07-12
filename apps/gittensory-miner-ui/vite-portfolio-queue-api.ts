import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only portfolio-queue API (#4306) — the sibling of `vite-run-state-api.ts` (#4305), same shape for
// the same reason: the dashboard is a browser app while the queue store is a `node:sqlite` file on disk, so the
// dev server bridges the two by calling into `packages/gittensory-miner/lib/portfolio-queue.js`'s EXISTING
// exports (`resolvePortfolioQueueDbPath`/`listQueue`).
//
// Reunified with the CLI's own richer dashboard (#4846): the aggregation is now
// `packages/gittensory-miner/lib/portfolio-dashboard.js`'s `collectPortfolioDashboard` -- the SAME pure
// aggregator `gittensory-miner queue dashboard` and the read-only MCP tool already use -- instead of a
// narrower global-only re-implementation, so the miner-ui and the CLI share one data path. It still aggregates
// server-side so the HTTP surface never republishes raw queue identifiers or rank-derived priorities; only
// status counts, grouped globally and per repo, cross the wire.
//
// Same read-only fresh-install rule as the run-state endpoint: `listQueue()` lazily initializes the default
// store, which would CREATE the SQLite file — so the handler probes the resolved DB path first and serves an
// empty summary without ever touching the store when no DB exists yet.

import type { PortfolioDashboardSummary } from "../../packages/gittensory-miner/lib/portfolio-dashboard.js";

type PortfolioQueueModule = {
  resolvePortfolioQueueDbPath: () => string;
  listQueue: (repoFullName?: string | null) => Array<{ repoFullName: string; status: string; enqueuedAt: string }>;
};

type PortfolioDashboardModule = {
  collectPortfolioDashboard: (
    sources: { portfolioQueue: { listQueue: PortfolioQueueModule["listQueue"] } },
    options: { nowMs: number },
  ) => PortfolioDashboardSummary;
};

export type PortfolioQueueApiDeps = {
  /** Import of `packages/gittensory-miner/lib/portfolio-queue.js` — injectable so tests never touch a real store. */
  loadPortfolioQueueModule: () => Promise<PortfolioQueueModule>;
  /** Import of `packages/gittensory-miner/lib/portfolio-dashboard.js` — dynamic for the same reason as
   *  `loadPortfolioQueueModule` (it transitively pulls in `node:sqlite` via portfolio-queue.js, which the UI's
   *  client-side test/build environment cannot bundle) and injectable so tests never touch a real store. */
  loadPortfolioDashboardModule: () => Promise<PortfolioDashboardModule>;
  /** File-existence probe for the fresh-install fast path. */
  fileExists: (path: string) => boolean;
  /** Clock for `oldestQueuedAgeMs` — injectable so tests get deterministic ages. */
  now: () => number;
};

function emptyPortfolioQueueSummary(): PortfolioDashboardSummary {
  return { total: 0, byStatus: { queued: 0, in_progress: 0, done: 0 }, repos: [], oldestQueuedAgeMs: null };
}

const defaultDeps: PortfolioQueueApiDeps = {
  loadPortfolioQueueModule: () =>
    import("../../packages/gittensory-miner/lib/portfolio-queue.js") as Promise<PortfolioQueueModule>,
  loadPortfolioDashboardModule: () =>
    import("../../packages/gittensory-miner/lib/portfolio-dashboard.js") as Promise<PortfolioDashboardModule>,
  fileExists: existsSync,
  now: () => Date.now(),
};

/** Request handler factored out of the Vite plugin shape so tests drive it directly (mirrors the run-state API). */
export async function handlePortfolioQueueRequest(
  method: string | undefined,
  url: string | undefined,
  deps: PortfolioQueueApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/portfolio-queue" || (method !== undefined && method !== "GET")) return null;
  try {
    const queue = await deps.loadPortfolioQueueModule();
    if (!deps.fileExists(queue.resolvePortfolioQueueDbPath())) {
      return { status: 200, body: JSON.stringify({ summary: emptyPortfolioQueueSummary() }) };
    }
    const { collectPortfolioDashboard } = await deps.loadPortfolioDashboardModule();
    const summary = collectPortfolioDashboard(
      { portfolioQueue: { listQueue: queue.listQueue } },
      { nowMs: deps.now() },
    );
    return { status: 200, body: JSON.stringify({ summary }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read local portfolio queue";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only portfolio-queue endpoint. */
export function portfolioQueueApiPlugin(deps: PortfolioQueueApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      void handlePortfolioQueueRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:portfolio-queue-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
