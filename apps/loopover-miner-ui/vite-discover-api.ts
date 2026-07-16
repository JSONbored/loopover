import type { Plugin } from "vite";

import type { DiscoverResult, RunDiscoverOptions } from "../../packages/loopover-miner/lib/discover-cli.js";

// `discover` action-dispatch surface for the miner-ui (#6522): the first HTTP route mirroring the AMS miner's
// own action-taking commands, alongside the sibling vite-attempt-api.ts. Until now `discover` existed only as a
// CLI subcommand (bin/loopover-miner.js -> runDiscover). This file is a thin bridge to the EXISTING, unmodified
// `runDiscover` entry point (packages/loopover-miner/lib/discover-cli.js) -- it marshals a POST JSON body into
// the same CLI-style `args: string[]` parseDiscoverArgs already accepts, calls runDiscover, and marshals the
// structured result back out. It does NOT reimplement fan-out/rank/enqueue: the route's only job is request
// marshaling, so there is no parallel or bypass discovery path.
//
// Structured result capture: runDiscover's only outputs used to be a console.log (stdout) plus a numeric exit
// code. #6522 added an `options.onResult` hook (mirroring runAttempt's proven convention) that fires with the
// real structured result at each of its two success points, so this route reads the structured outcome directly
// instead of scraping stdout.
//
// Auth: like every sibling /api/* route this file is registered AFTER authPlugin() in vite.config.ts's plugin
// list, so vite-auth.ts's same-origin HttpOnly cookie gate covers it automatically -- no per-route auth wiring.
//
// No credential is ever read from the request body: GITHUB_TOKEN / the tenant's token env var is resolved
// server-side by runDiscover itself, exactly as the CLI does. Only non-secret passthrough fields (repo targets,
// search query, apiBaseUrl, the NAME of a token-env var, dryRun, json) are marshaled into the args array.
//
// matchDiscoverRoute() is checked SYNCHRONOUSLY before any body read: every other request this middleware sees
// must fall through to next() immediately, without this plugin touching a stream it has no business reading.

type DiscoverCliModule = {
  runDiscover: (args: string[], options?: RunDiscoverOptions) => Promise<number>;
};

export type DiscoverApiDeps = {
  /** Import of `packages/loopover-miner/lib/discover-cli.js` — injectable so tests never touch a real store,
   *  network, or the GitHub fan-out. */
  loadDiscoverCliModule: () => Promise<DiscoverCliModule>;
};

const defaultDeps: DiscoverApiDeps = {
  loadDiscoverCliModule: () =>
    import("../../packages/loopover-miner/lib/discover-cli.js") as Promise<DiscoverCliModule>,
};

/** The non-secret subset of a `/api/discover` POST body. A caller-supplied `githubToken`/`token`/`apiKey` field
 *  is never in this shape and is dropped, not threaded through — credentials are resolved server-side only. */
type DiscoverRequestBody = {
  targets: string[];
  search?: string;
  dryRun: boolean;
  json: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

export type DiscoverRoute = "discover-post";

/** Pure route matcher, no I/O — safe to call synchronously before deciding whether to read a request body. */
export function matchDiscoverRoute(method: string | undefined, url: string | undefined): DiscoverRoute | null {
  if (url === "/api/discover" && method === "POST") return "discover-post";
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

function trimmedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

/** Parses the POST body into the non-secret discover request shape, or null for a malformed / missing-required
 *  body (neither repo targets nor a search query). Mirrors vite-portfolio-queue-actions-api.ts's parseActionBody
 *  convention: a malformed body never reaches runDiscover at all. */
function parseDiscoverBody(rawBody: string): DiscoverRequestBody | null {
  if (!rawBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const targets = trimmedStringArray(record.targets);
  const search = typeof record.search === "string" && record.search.trim() ? record.search.trim() : undefined;
  // Required: at least one repo target OR a search query — the same "either targets or --search" contract the
  // CLI's parseDiscoverArgs enforces. Neither present is a missing-required-field body → 400.
  if (targets.length === 0 && search === undefined) return null;
  const body: DiscoverRequestBody = {
    targets,
    dryRun: record.dryRun === true,
    json: record.json === true,
  };
  if (search !== undefined) body.search = search;
  if (typeof record.apiBaseUrl === "string" && record.apiBaseUrl.trim()) body.apiBaseUrl = record.apiBaseUrl.trim();
  if (typeof record.tokenEnv === "string" && record.tokenEnv.trim()) body.tokenEnv = record.tokenEnv.trim();
  return body;
}

/** Builds the CLI-style args array parseDiscoverArgs accepts from the parsed body — the only entry point into
 *  runDiscover is a `string[]`, so the route constructs argv rather than calling a lower-level structured API. */
function buildDiscoverArgs(body: DiscoverRequestBody): string[] {
  const args = [...body.targets];
  if (body.search !== undefined) args.push("--search", body.search);
  if (body.dryRun) args.push("--dry-run");
  if (body.json) args.push("--json");
  if (body.apiBaseUrl !== undefined) args.push("--api-base-url", body.apiBaseUrl);
  if (body.tokenEnv !== undefined) args.push("--token-env", body.tokenEnv);
  return args;
}

async function respondToDiscoverRoute(
  rawBody: string,
  deps: DiscoverApiDeps,
): Promise<{ status: number; body: string }> {
  const body = parseDiscoverBody(rawBody);
  if (!body) {
    return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
  }
  try {
    const discoverCli = await deps.loadDiscoverCliModule();
    let captured: DiscoverResult | undefined;
    const exitCode = await discoverCli.runDiscover(buildDiscoverArgs(body), {
      onResult: (result) => {
        captured = result;
      },
    });
    if (captured !== undefined) {
      return { status: 200, body: JSON.stringify({ result: captured, exitCode }) };
    }
    // Exit-code-only branch: runDiscover returned non-zero (a reportCliFailure site) WITHOUT ever firing
    // onResult, so there is no structured result to return. Respond with a clear error status carrying the raw
    // exit code rather than crashing on an assumed-present result object.
    return { status: 502, body: JSON.stringify({ error: "discover_failed", exitCode }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to run local discover";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Request handler factored out for direct unit tests (mirrors vite-governor-api.ts's handleGovernorRequest).
 *  Returns null when the request is not for the discover route (caller falls through). */
export async function handleDiscoverRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: DiscoverApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  const route = matchDiscoverRoute(method, url);
  if (!route) return null;
  return respondToDiscoverRoute(rawBody, deps);
}

/** Vite dev/preview middleware serving the POST /api/discover action route. */
export function discoverApiPlugin(deps: DiscoverApiDeps = defaultDeps): Plugin {
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
      const route = matchDiscoverRoute(req.method, req.url);
      if (!route) return next();
      void readRequestBody(req)
        .then((rawBody) => respondToDiscoverRoute(rawBody, deps))
        .then((handled) => {
          res.statusCode = handled.status;
          res.setHeader("Content-Type", "application/json");
          res.end(handled.body);
        });
    });
  };
  return {
    name: "gittensory-miner-ui:discover-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
