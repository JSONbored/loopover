import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only discovery API (#4859) — the third sibling of `vite-run-state-api.ts` (#4305) and
// `vite-portfolio-queue-api.ts` (#4306), same shape for the same reason: the miner's stores are `node:sqlite`
// files on disk, so the dev/preview server bridges them to a browser client. GET /api/discovery returns the
// latest ranked discovery candidate per issue by calling into `packages/gittensory-miner/lib/discovered-candidates.js`'s
// EXISTING export (`listDiscoveredRankedCandidates`) — no ledger query duplicated in the UI layer, strictly read-only.
//
// This is the "localhost-reachability gap" the contributor miner extension needed closed: it now has a local
// channel to fetch its ranked candidates instead of a manual copy/paste of `discover --json`. Fetched from the
// extension's OWN page/service worker (a chrome-extension:// origin holding a localhost host permission), so the
// browser bypasses CORS — no `Access-Control-*` headers are served, matching the two sibling endpoints.
//
// Loopback guard (mirrors run-state, #4305): the ranked scores are the operator's own local discovery output, so
// the endpoint refuses any non-loopback caller rather than exposing them off-box.
//
// Same read-only fresh-install rule as the sibling endpoints: the reader lazily initializes the default event
// ledger, which would CREATE the SQLite file — so the handler probes the resolved DB path first and serves an
// empty list without ever touching the store when no ledger exists yet.

import type { DiscoveredRankedCandidate } from "../../packages/gittensory-miner/lib/discovered-candidates.js";

type DiscoveredCandidatesModule = {
  resolveEventLedgerDbPath: () => string;
  listDiscoveredRankedCandidates: () => DiscoveredRankedCandidate[];
};

export type DiscoveryApiDeps = {
  /** Import of the discovered-candidates reader (+ the event-ledger path resolver it reads) — injectable so
   *  tests never touch a real store. `resolveEventLedgerDbPath` re-exported from the event ledger drives the
   *  fresh-install probe below. */
  loadDiscoveredCandidatesModule: () => Promise<DiscoveredCandidatesModule>;
  /** File-existence probe for the fresh-install fast path. */
  fileExists: (path: string) => boolean;
};

function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return true;
  return (
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1" ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress.startsWith("127.")
  );
}

const defaultDeps: DiscoveryApiDeps = {
  loadDiscoveredCandidatesModule: async () => {
    const [{ listDiscoveredRankedCandidates }, { resolveEventLedgerDbPath }] = await Promise.all([
      import("../../packages/gittensory-miner/lib/discovered-candidates.js"),
      import("../../packages/gittensory-miner/lib/event-ledger.js"),
    ]);
    return { listDiscoveredRankedCandidates, resolveEventLedgerDbPath };
  },
  fileExists: existsSync,
};

/** Request handler factored out of the Vite plugin shape so tests drive it directly (mirrors the run-state API).
 *  Returns the JSON body + status for a loopback GET, or null when the request is not for this endpoint. */
export async function handleDiscoveryRequest(
  method: string | undefined,
  url: string | undefined,
  deps: DiscoveryApiDeps = defaultDeps,
  remoteAddress?: string,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/discovery" || (method !== undefined && method !== "GET")) return null;
  if (!isLoopbackAddress(remoteAddress)) {
    return { status: 403, body: JSON.stringify({ error: "discovery API is only available from loopback clients" }) };
  }
  try {
    const discovery = await deps.loadDiscoveredCandidatesModule();
    // Fresh install: no ledger file yet. Serve the empty list WITHOUT initializing the ledger (that would create
    // the file — a write this read-only endpoint must never perform).
    if (!deps.fileExists(discovery.resolveEventLedgerDbPath())) {
      return { status: 200, body: JSON.stringify({ rankedCandidates: [] }) };
    }
    return { status: 200, body: JSON.stringify({ rankedCandidates: discovery.listDiscoveredRankedCandidates() }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read local discovery candidates";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only discovery endpoint. */
export function discoveryApiPlugin(deps: DiscoveryApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; socket?: { remoteAddress?: string }; url?: string },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      void handleDiscoveryRequest(req.method, req.url, deps, req.socket?.remoteAddress).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:discovery-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
