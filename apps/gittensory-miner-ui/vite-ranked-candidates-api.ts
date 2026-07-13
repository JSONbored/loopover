import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only ranked-candidates API (#4859 prerequisite): the browser extension's opportunity badge
// (apps/gittensory-miner-extension/opportunity-badge.js) needs the miner's last discover run's full per-issue
// ranking breakdown to replace its manual copy/paste workflow with a live fetch. Bridges the browser app to
// packages/gittensory-miner/lib/ranked-candidates.js's EXISTING exports (resolveRankedCandidatesDbPath/
// listRankedCandidates) -- no ranking logic duplicated in the UI layer, strictly read-only.
//
// Authenticated the same way as every other /api/* route: vite-auth.ts's authPlugin runs first in the Connect
// chain (#4858), so this file needs no auth logic of its own.
//
// Same read-only fresh-install rule as the sibling GET endpoints: `listRankedCandidates()` lazily initializes
// the default store, which would CREATE the SQLite file -- a write -- on a fresh install or before the first
// discover run. So the handler checks the resolved DB path for existence first and serves an empty snapshot
// without ever touching the store when no DB exists yet.

type RankedCandidateRow = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  htmlUrl: string | null;
  rankScore: number;
  laneFit: number;
  freshness: number;
  potential: number;
  feasibility: number;
  dupRisk: number;
  rankedAt: string;
};

type RankedCandidatesModule = {
  resolveRankedCandidatesDbPath: () => string;
  listRankedCandidates: () => RankedCandidateRow[];
};

export type RankedCandidatesApiDeps = {
  /** Import of `packages/gittensory-miner/lib/ranked-candidates.js` — injectable so tests never touch a real store. */
  loadRankedCandidatesModule: () => Promise<RankedCandidatesModule>;
  /** File-existence probe for the fresh-install fast path. */
  fileExists: (path: string) => boolean;
};

const defaultDeps: RankedCandidatesApiDeps = {
  loadRankedCandidatesModule: () =>
    import("../../packages/gittensory-miner/lib/ranked-candidates.js") as Promise<RankedCandidatesModule>,
  fileExists: existsSync,
};

/** The request handler, factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling
 *  API files' handleXRequest pattern). Returns the JSON body + status for a GET, or null when the request is
 *  not for this endpoint (caller falls through). */
export async function handleRankedCandidatesRequest(
  method: string | undefined,
  url: string | undefined,
  deps: RankedCandidatesApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/ranked-candidates" || (method !== undefined && method !== "GET")) return null;
  try {
    const rankedCandidates = await deps.loadRankedCandidatesModule();
    if (!deps.fileExists(rankedCandidates.resolveRankedCandidatesDbPath())) {
      return { status: 200, body: JSON.stringify({ candidates: [] }) };
    }
    return { status: 200, body: JSON.stringify({ candidates: rankedCandidates.listRankedCandidates() }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read the local ranked-candidates snapshot";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only ranked-candidates endpoint. */
export function rankedCandidatesApiPlugin(deps: RankedCandidatesApiDeps = defaultDeps): Plugin {
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
      void handleRankedCandidatesRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:ranked-candidates-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
