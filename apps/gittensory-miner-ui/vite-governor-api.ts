import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Governor pause/resume control surface for the miner-ui (#4857, the governor half): the miner-ui was 100%
// read-only until #4858 added real authentication to /api/* -- this is the first write-capable endpoint, and it
// only exists because that auth gate now covers it automatically (registered after authPlugin() in
// vite.config.ts's plugin list, same as the read-only siblings). It is a thin bridge to the EXISTING
// governor-state.js exports (`loadPauseState`/`savePauseState`) the CLI's `governor pause`/`governor resume`/
// `governor status` subcommands already use (governor-pause-cli.js) -- no new pause/resume semantics are
// invented here, and this file never touches governor-chokepoint.js/governor-chokepoint-persisted.js (the
// governor's actual decision-to-proceed logic stays untouched, per #4857's own scope note).
//
// Queue release/requeue actions live in vite-portfolio-queue-actions-api.ts (#4857, the queue half).
//
// Same read-only-safe fresh-install rule as the sibling GET endpoints for the READ route only: `loadPauseState()`
// lazily initializes the default store, which would CREATE the SQLite file (a write) on a fresh install -- so
// GET checks the resolved DB path for existence first and serves the "not paused" default without ever opening
// the store. The two POST routes have no such fast path: pausing/resuming on a fresh install is expected to
// create the store, exactly like the CLI's own `governor pause`/`governor resume` commands already do.
//
// matchGovernorRoute() is checked SYNCHRONOUSLY, before ever reading a request body: every other request this
// middleware sees (every page/asset load, every OTHER /api/* route) must fall through to `next()` immediately,
// without this plugin consuming (or even touching) a request stream it has no business reading.

type GovernorPauseState = { paused: boolean; reason: string | null; pausedAt: string | null };

type GovernorStateModule = {
  resolveGovernorStateDbPath: () => string;
  loadPauseState: () => GovernorPauseState;
  savePauseState: (input: { paused: boolean; reason?: string | null }) => GovernorPauseState;
};

export type GovernorApiDeps = {
  /** Import of `packages/gittensory-miner/lib/governor-state.js` — injectable so tests never touch a real store. */
  loadGovernorStateModule: () => Promise<GovernorStateModule>;
  /** File-existence probe for the fresh-install fast path on the GET route. */
  fileExists: (path: string) => boolean;
};

const defaultDeps: GovernorApiDeps = {
  loadGovernorStateModule: () =>
    import("../../packages/gittensory-miner/lib/governor-state.js") as Promise<GovernorStateModule>,
  fileExists: existsSync,
};

function notPausedDefault(): GovernorPauseState {
  return { paused: false, reason: null, pausedAt: null };
}

type GovernorRoute = "pause-state-get" | "pause-post" | "resume-post";

/** Pure route matcher, no I/O — safe to call synchronously before deciding whether to read a request body at
 *  all. Exported so the plugin's own pre-check and `handleGovernorRequest` share exactly one definition of
 *  "which of the three governor routes (if any) does this request match." */
export function matchGovernorRoute(method: string | undefined, url: string | undefined): GovernorRoute | null {
  if (url === "/api/governor/pause-state" && (method === undefined || method === "GET")) return "pause-state-get";
  if (url === "/api/governor/pause" && method === "POST") return "pause-post";
  if (url === "/api/governor/resume" && method === "POST") return "resume-post";
  return null;
}

/** Collects a request body into a string. Every route here has a small (or empty) JSON body, so no size cap is
 *  needed beyond what Node's own default HTTP request-size limits already enforce. */
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

/** Parses an optional `{ reason?: string }` POST body for the pause route. An empty body, invalid JSON, or a
 *  non-string `reason` all fall back to no reason rather than failing the request — a malformed body is not
 *  worth rejecting a genuine pause request over. */
function parsePauseReason(rawBody: string): string | undefined {
  if (!rawBody.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const reason = (parsed as { reason?: unknown })?.reason;
    return typeof reason === "string" && reason.trim() ? reason.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Executes an ALREADY-MATCHED governor route. Never returns null — callers (the plugin middleware and
 *  `handleGovernorRequest` below) only reach this once `matchGovernorRoute` has confirmed a match, so there is
 *  no "not my route" case left to represent here. */
async function respondToGovernorRoute(
  route: GovernorRoute,
  rawBody: string,
  deps: GovernorApiDeps,
): Promise<{ status: number; body: string }> {
  try {
    const governor = await deps.loadGovernorStateModule();
    if (route === "pause-state-get") {
      if (!deps.fileExists(governor.resolveGovernorStateDbPath())) {
        return { status: 200, body: JSON.stringify({ pauseState: notPausedDefault() }) };
      }
      return { status: 200, body: JSON.stringify({ pauseState: governor.loadPauseState() }) };
    }
    if (route === "pause-post") {
      const pauseState = governor.savePauseState({ paused: true, reason: parsePauseReason(rawBody) });
      return { status: 200, body: JSON.stringify({ pauseState }) };
    }
    const pauseState = governor.savePauseState({ paused: false }); // route === "resume-post"
    return { status: 200, body: JSON.stringify({ pauseState }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to update the local governor pause state";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** The request handler, factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling
 *  API files' handleXRequest pattern). Returns null when the request is for none of the three governor routes. */
export async function handleGovernorRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: GovernorApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  const route = matchGovernorRoute(method, url);
  if (!route) return null;
  return respondToGovernorRoute(route, rawBody, deps);
}

/** Vite dev/preview middleware serving the governor pause-state read + pause/resume write endpoints. */
export function governorApiPlugin(deps: GovernorApiDeps = defaultDeps): Plugin {
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
      const route = matchGovernorRoute(req.method, req.url);
      if (!route) return next();
      void readRequestBody(req)
        .then((rawBody) => respondToGovernorRoute(route, rawBody, deps))
        .then((handled) => {
          res.statusCode = handled.status;
          res.setHeader("Content-Type", "application/json");
          res.end(handled.body);
        });
    });
  };
  return {
    name: "gittensory-miner-ui:governor-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
