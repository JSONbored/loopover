import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Portfolio-queue release/requeue control surface for the miner-ui (#4857, the queue half): a thin bridge to the
// EXISTING store methods the CLI's `queue release` / `queue requeue` subcommands already use
// (portfolio-queue-cli.js → reclaimStuckItem / requeueItem) — no new queue semantics are invented here.
//
// Unlike the read-only dashboard GET in vite-portfolio-queue-api.ts, these routes intentionally republish each
// item's `identifier` (plus repo + forge host) to the authenticated local UI so an operator can act on a
// specific row. That exposure is acceptable here because vite-auth.ts (#4858) already gates every /api/*
// request behind a same-origin HttpOnly session cookie — the identifiers never cross an unauthenticated wire.
//
// GET `/api/portfolio-queue/items` follows the sibling fresh-install rule: if the resolved DB file does not
// exist yet, serve an empty list without opening the store (which would CREATE the file). The two POST routes
// have no such fast path — mutating on a fresh install is expected to create the store, like the CLI.

type QueueEntry = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: string;
};

type PortfolioQueueModule = {
  resolvePortfolioQueueDbPath: () => string;
  initPortfolioQueueStore: () => {
    listQueue: (repoFullName?: string | null) => QueueEntry[];
    reclaimStuckItem: (repoFullName: string, identifier: string, apiBaseUrl?: string | null) => QueueEntry | null;
    requeueItem: (repoFullName: string, identifier: string, apiBaseUrl?: string | null) => QueueEntry | null;
    close: () => void;
  };
};

export type PortfolioQueueActionItem = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: "in_progress" | "done";
};

export type PortfolioQueueActionsApiDeps = {
  loadPortfolioQueueModule: () => Promise<PortfolioQueueModule>;
  fileExists: (path: string) => boolean;
};

const defaultDeps: PortfolioQueueActionsApiDeps = {
  loadPortfolioQueueModule: () =>
    import("../../packages/gittensory-miner/lib/portfolio-queue.js") as Promise<PortfolioQueueModule>,
  fileExists: existsSync,
};

function emptyItemsResponse(): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ items: [] as PortfolioQueueActionItem[] }) };
}

function toActionItem(entry: QueueEntry): PortfolioQueueActionItem | null {
  if (entry.status !== "in_progress" && entry.status !== "done") return null;
  return {
    apiBaseUrl: entry.apiBaseUrl,
    repoFullName: entry.repoFullName,
    identifier: entry.identifier,
    status: entry.status,
  };
}

function parseActionBody(rawBody: string): { repoFullName: string; identifier: string; apiBaseUrl?: string } | null {
  if (!rawBody.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const record = parsed as { repoFullName?: unknown; identifier?: unknown; apiBaseUrl?: unknown };
    if (typeof record.repoFullName !== "string" || typeof record.identifier !== "string") return null;
    const repoFullName = record.repoFullName.trim();
    const identifier = record.identifier.trim();
    if (!repoFullName || !identifier) return null;
    const body: { repoFullName: string; identifier: string; apiBaseUrl?: string } = { repoFullName, identifier };
    if (typeof record.apiBaseUrl === "string" && record.apiBaseUrl.trim()) {
      body.apiBaseUrl = record.apiBaseUrl.trim();
    }
    return body;
  } catch {
    return null;
  }
}

export type PortfolioQueueActionRoute = "items-get" | "release-post" | "requeue-post";

/** Pure route matcher — safe to call synchronously before reading a request body. */
export function matchPortfolioQueueActionRoute(
  method: string | undefined,
  url: string | undefined,
): PortfolioQueueActionRoute | null {
  if (url === "/api/portfolio-queue/items" && (method === undefined || method === "GET")) return "items-get";
  if (url === "/api/portfolio-queue/release" && method === "POST") return "release-post";
  if (url === "/api/portfolio-queue/requeue" && method === "POST") return "requeue-post";
  return null;
}

function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function respondToPortfolioQueueActionRoute(
  route: PortfolioQueueActionRoute,
  rawBody: string,
  deps: PortfolioQueueActionsApiDeps,
): Promise<{ status: number; body: string }> {
  try {
    const queueModule = await deps.loadPortfolioQueueModule();
    if (route === "items-get") {
      if (!deps.fileExists(queueModule.resolvePortfolioQueueDbPath())) {
        return emptyItemsResponse();
      }
      const store = queueModule.initPortfolioQueueStore();
      try {
        const items = store
          .listQueue()
          .map(toActionItem)
          .filter((item): item is PortfolioQueueActionItem => item !== null);
        return { status: 200, body: JSON.stringify({ items }) };
      } finally {
        store.close();
      }
    }

    const parsed = parseActionBody(rawBody);
    if (!parsed) {
      return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
    }

    const store = queueModule.initPortfolioQueueStore();
    try {
      if (route === "release-post") {
        const entry = store.reclaimStuckItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl ?? null);
        if (!entry) {
          return { status: 409, body: JSON.stringify({ error: "queue_entry_not_in_progress" }) };
        }
        return {
          status: 200,
          body: JSON.stringify({
            entry: { repoFullName: entry.repoFullName, identifier: entry.identifier, status: entry.status },
          }),
        };
      }
      const entry = store.requeueItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl ?? null);
      if (!entry) {
        return { status: 409, body: JSON.stringify({ error: "queue_entry_not_requeuable" }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          entry: { repoFullName: entry.repoFullName, identifier: entry.identifier, status: entry.status },
        }),
      };
    } finally {
      store.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to update the local portfolio queue";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Request handler factored out for direct unit tests (mirrors vite-governor-api.ts). */
export async function handlePortfolioQueueActionsRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: PortfolioQueueActionsApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  const route = matchPortfolioQueueActionRoute(method, url);
  if (!route) return null;
  return respondToPortfolioQueueActionRoute(route, rawBody, deps);
}

/** Vite dev/preview middleware for portfolio-queue item listing + release/requeue write endpoints. */
export function portfolioQueueActionsApiPlugin(deps: PortfolioQueueActionsApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string } & NodeJS.ReadableStream,
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      const route = matchPortfolioQueueActionRoute(req.method, req.url);
      if (!route) return next();
      const run =
        route === "items-get"
          ? respondToPortfolioQueueActionRoute(route, "", deps)
          : readRequestBody(req).then((rawBody) => respondToPortfolioQueueActionRoute(route, rawBody, deps));
      void Promise.resolve(run).then((handled) => {
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:portfolio-queue-actions-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
