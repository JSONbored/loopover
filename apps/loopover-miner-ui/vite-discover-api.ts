import type { Plugin } from "vite";

// discover HTTP surface for the miner-ui (#6522): the first HTTP route for the AMS miner's own action-taking
// commands. `discover` existed only as a CLI subcommand (packages/loopover-miner/bin/loopover-miner.js) until
// now — this is a thin, non-bypassing bridge to the EXISTING `runDiscover` entry point (discover-cli.js), the
// same one the CLI calls. It reimplements none of the fan-out/rank/enqueue pipeline; its only job is to marshal
// a POST body into `runDiscover`'s CLI-style args array and marshal the structured result back out.
//
// Attempt's release/requeue-equivalent pair lives in vite-attempt-api.ts (the other half of #6522).
//
// Like every sibling /api/* route, this middleware is registered AFTER authPlugin() in vite.config.ts, so an
// unauthenticated request is rejected before it ever reaches this handler — there is no per-route auth wiring.
// `discover` has no Governor chokepoint of its own (it only fans out + ranks + enqueues, none of the gated
// write actions), so — matching the CLI exactly — this route adds none either.
//
// matchDiscoverRoute() is a pure synchronous check, run before any request body is read, so every unrelated
// request (assets, other /api/* routes) falls straight through to next() without this plugin touching its stream.

/** Non-secret discover inputs accepted from the POST body — the exact CLI flags `parseDiscoverArgs` accepts,
 *  never a credential. `githubToken`/`token`/`apiKey`-shaped fields are intentionally never read (the miner's
 *  local harness resolves its own credentials server-side, exactly as the CLI does). */
type DiscoverRequest = {
  targets: string[];
  search: string | null;
  dryRun: boolean;
  json: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

export type DiscoverApiDeps = {
  /** The real `runDiscover` from discover-cli.js — injectable so tests never touch a real store, network, or
   *  worktree. `onResult` captures the structured outcome (#6522) without depending on the exit code alone. */
  runDiscover: (args: string[], options: { onResult: (result: unknown) => void }) => Promise<number>;
};

const defaultDeps: DiscoverApiDeps = {
  runDiscover: async (args, options) => {
    const mod = (await import("../../packages/loopover-miner/lib/discover-cli.js")) as {
      runDiscover: (args: string[], options?: { onResult?: (result: unknown) => void }) => Promise<number>;
    };
    return mod.runDiscover(args, options);
  },
};

export type DiscoverRoute = "discover-post";

/** Pure route matcher — safe to call synchronously before reading a request body. */
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

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim());
}

/** Parse the POST body into the non-secret discover inputs, or null when it is malformed or has neither a
 *  repository target nor a search query (parseDiscoverArgs requires exactly one of the two). Credential-shaped
 *  fields are never read off the body. */
function parseDiscoverBody(rawBody: string): DiscoverRequest | null {
  if (!rawBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const targets = isNonEmptyStringArray(record.targets) ? record.targets.map((entry) => entry.trim()) : [];
  const search = typeof record.search === "string" && record.search.trim() ? record.search.trim() : null;
  if (targets.length === 0 && search === null) return null;

  const request: DiscoverRequest = {
    targets,
    search,
    dryRun: record.dryRun === true,
    json: record.json === true,
  };
  if (typeof record.apiBaseUrl === "string" && record.apiBaseUrl.trim()) request.apiBaseUrl = record.apiBaseUrl.trim();
  if (typeof record.tokenEnv === "string" && record.tokenEnv.trim()) request.tokenEnv = record.tokenEnv.trim();
  return request;
}

/** Build `runDiscover`'s CLI-style args from the parsed body — its only user-facing entry point is
 *  `parseDiscoverArgs(args: string[])`, so there is no lower-level structured-input path to call instead. */
function buildDiscoverArgs(request: DiscoverRequest): string[] {
  const args: string[] = [...request.targets];
  if (request.search !== null) args.push("--search", request.search);
  if (request.dryRun) args.push("--dry-run");
  if (request.json) args.push("--json");
  if (request.apiBaseUrl !== undefined) args.push("--api-base-url", request.apiBaseUrl);
  if (request.tokenEnv !== undefined) args.push("--token-env", request.tokenEnv);
  return args;
}

async function respondToDiscoverRoute(
  rawBody: string,
  deps: DiscoverApiDeps,
): Promise<{ status: number; body: string }> {
  const request = parseDiscoverBody(rawBody);
  if (!request) {
    return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
  }
  try {
    let result: unknown;
    let captured = false;
    const exitCode = await deps.runDiscover(buildDiscoverArgs(request), {
      onResult: (value) => {
        result = value;
        captured = true;
      },
    });
    // runDiscover fires onResult only at a real structured success point; a non-zero exit that never called it
    // (a parse-error/unexpected-error branch) has no result object to return, so surface it as an error rather
    // than crashing on an assumed-present result.
    if (!captured) {
      return { status: 502, body: JSON.stringify({ error: "discover_failed", exitCode }) };
    }
    return { status: 200, body: JSON.stringify({ result, exitCode }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to run local discover";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Request handler factored out for direct unit tests (mirrors vite-governor-api.ts). Returns null when the
 *  request is not the discover route. */
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

/** Vite dev/preview middleware serving POST /api/discover. */
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
