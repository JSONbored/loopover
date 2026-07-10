import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only run-state API (#4305). The dashboard is a browser app while the miner's stores are
// `node:sqlite` files on disk, so the dev server bridges the two: GET /api/run-state returns the
// `miner_run_state` rows by calling into `packages/gittensory-miner/lib/run-state.js`'s EXISTING exports
// (`resolveRunStateDbPath`/`listRunStates`) — no SQL duplicated in the UI layer, and strictly read-only.
//
// Empty-state subtlety: `listRunStates()` lazily INITIALIZES the default store, which would CREATE the SQLite
// file on a fresh install — a write, which a read-only dashboard must not perform. So the handler checks the
// resolved DB path for existence FIRST and serves `[]` without ever touching the store when no DB exists yet.

type RunStateModule = {
  resolveRunStateDbPath: () => string;
  listRunStates: () => Array<{ repoFullName: string; state: string; updatedAt: string }>;
};

export type RunStateApiDeps = {
  /** Import of `packages/gittensory-miner/lib/run-state.js` — injectable so tests never touch a real store. */
  loadRunStateModule: () => Promise<RunStateModule>;
  /** File-existence probe for the fresh-install fast path. */
  fileExists: (path: string) => boolean;
};

const defaultDeps: RunStateApiDeps = {
  loadRunStateModule: () => import("../../packages/gittensory-miner/lib/run-state.js") as Promise<RunStateModule>,
  fileExists: existsSync,
};

/** The request handler, factored out of the Vite plugin shape so tests drive it directly. Returns the JSON
 *  body + status for a GET, or null when the request is not for this endpoint (caller falls through). */
export async function handleRunStateRequest(
  method: string | undefined,
  url: string | undefined,
  deps: RunStateApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/run-state" || (method !== undefined && method !== "GET")) return null;
  try {
    const runState = await deps.loadRunStateModule();
    // Fresh install: no DB file yet. Serve the empty list WITHOUT initializing the store (that would create
    // the file — a write this read-only endpoint must never perform).
    if (!deps.fileExists(runState.resolveRunStateDbPath())) {
      return { status: 200, body: JSON.stringify({ rows: [] }) };
    }
    return { status: 200, body: JSON.stringify({ rows: runState.listRunStates() }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read local run state";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only run-state endpoint. */
export function runStateApiPlugin(deps: RunStateApiDeps = defaultDeps): Plugin {
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
      void handleRunStateRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:run-state-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
