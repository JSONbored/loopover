import type { Plugin } from "vite";

// attempt HTTP surface for the miner-ui (#6522): a thin, non-bypassing bridge to the EXISTING `runAttempt`
// entry point (attempt-cli.js), the same one the CLI's `attempt` subcommand calls. It reimplements none of the
// worktree / coding-agent / chokepoint pipeline — its only job is to marshal a POST body into `runAttempt`'s
// CLI-style args array and marshal the structured result (already threaded through `runAttempt`'s own onResult)
// back out. Because it calls the real, unmodified `runAttempt`, it inherits that command's Governor chokepoint
// gate for free (attempt-runner.js routes every write through it), exactly as this route inherits vite-auth.ts's
// cookie gate for free by living under /api/* and being registered after authPlugin() in vite.config.ts.
//
// discover's route is vite-discover-api.ts (the other half of #6522).
//
// Unlike every other /api/* route in this app (synchronous local-store reads/writes), POST /api/attempt can run
// for MINUTES — it drives a full worktree checkout + coding-agent iteration — so this handler imposes no timeout
// of its own; a caller that needs one applies it at the fetch layer.
//
// matchAttemptRoute() is a pure synchronous check, run before any request body is read.

/** Non-secret attempt inputs accepted from the POST body — the exact CLI flags `parseAttemptArgs` accepts,
 *  never a credential. Credential resolution happens server-side in `runAttempt` (GITHUB_TOKEN / live session),
 *  so a `githubToken`/`token`/`apiKey`-shaped field on the body is intentionally never read. */
type AttemptRequest = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base?: string;
  live: boolean;
  dryRun: boolean;
  json: boolean;
};

export type AttemptApiDeps = {
  /** The real `runAttempt` from attempt-cli.js — injectable so tests never touch a real worktree, coding agent,
   *  or ledger. `onResult` captures the structured AttemptCliResult (which `runAttempt` already emits at every
   *  real return point) so the route can return it alongside the raw exit code. */
  runAttempt: (args: string[], options: { onResult: (result: unknown) => void }) => Promise<number>;
};

const defaultDeps: AttemptApiDeps = {
  runAttempt: async (args, options) => {
    const mod = (await import("../../packages/loopover-miner/lib/attempt-cli.js")) as {
      runAttempt: (args: string[], options?: { onResult?: (result: unknown) => void }) => Promise<number>;
    };
    return mod.runAttempt(args, options);
  },
};

export type AttemptRoute = "attempt-post";

/** Pure route matcher — safe to call synchronously before reading a request body. */
export function matchAttemptRoute(method: string | undefined, url: string | undefined): AttemptRoute | null {
  if (url === "/api/attempt" && method === "POST") return "attempt-post";
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

/** Parse the POST body into the non-secret attempt inputs, or null when it is malformed or missing a required
 *  field (`repoFullName`, a positive-integer `issueNumber`, and `minerLogin` are all required — the same three
 *  `parseAttemptArgs` requires). Credential-shaped fields are never read off the body. */
function parseAttemptBody(rawBody: string): AttemptRequest | null {
  if (!rawBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const repoFullName = typeof record.repoFullName === "string" ? record.repoFullName.trim() : "";
  const minerLogin = typeof record.minerLogin === "string" ? record.minerLogin.trim() : "";
  const issueNumber = typeof record.issueNumber === "number" ? record.issueNumber : Number.NaN;
  if (!repoFullName || !minerLogin) return null;
  if (!Number.isInteger(issueNumber) || issueNumber < 1) return null;

  const request: AttemptRequest = {
    repoFullName,
    issueNumber,
    minerLogin,
    live: record.live === true,
    dryRun: record.dryRun === true,
    json: record.json === true,
  };
  if (typeof record.base === "string" && record.base.trim()) request.base = record.base.trim();
  return request;
}

/** Build `runAttempt`'s CLI-style args from the parsed body — its only user-facing entry point is
 *  `parseAttemptArgs(args: string[])`, so the route constructs argv rather than calling a lower-level path. */
function buildAttemptArgs(request: AttemptRequest): string[] {
  const args: string[] = [request.repoFullName, String(request.issueNumber), "--miner-login", request.minerLogin];
  if (request.base !== undefined) args.push("--base", request.base);
  if (request.live) args.push("--live");
  if (request.dryRun) args.push("--dry-run");
  if (request.json) args.push("--json");
  return args;
}

async function respondToAttemptRoute(rawBody: string, deps: AttemptApiDeps): Promise<{ status: number; body: string }> {
  const request = parseAttemptBody(rawBody);
  if (!request) {
    return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
  }
  try {
    let result: unknown;
    let captured = false;
    const exitCode = await deps.runAttempt(buildAttemptArgs(request), {
      onResult: (value) => {
        result = value;
        captured = true;
      },
    });
    // runAttempt fires onResult at every real structured outcome (dry-run, rejected, blocked, infeasible, final)
    // — including governed rejections that still return a non-zero exit — so the result plus the raw exit code is
    // returned together. The parse-error/paused/unexpected-error branches never call onResult and have no
    // structured result to return; surface those as an error instead of assuming a result is present.
    if (!captured) {
      return { status: 502, body: JSON.stringify({ error: "attempt_failed", exitCode }) };
    }
    return { status: 200, body: JSON.stringify({ result, exitCode }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to run local attempt";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Request handler factored out for direct unit tests (mirrors vite-governor-api.ts). Returns null when the
 *  request is not the attempt route. */
export async function handleAttemptRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: AttemptApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  const route = matchAttemptRoute(method, url);
  if (!route) return null;
  return respondToAttemptRoute(rawBody, deps);
}

/** Vite dev/preview middleware serving POST /api/attempt. */
export function attemptApiPlugin(deps: AttemptApiDeps = defaultDeps): Plugin {
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
      const route = matchAttemptRoute(req.method, req.url);
      if (!route) return next();
      void readRequestBody(req)
        .then((rawBody) => respondToAttemptRoute(rawBody, deps))
        .then((handled) => {
          res.statusCode = handled.status;
          res.setHeader("Content-Type", "application/json");
          res.end(handled.body);
        });
    });
  };
  return {
    name: "gittensory-miner-ui:attempt-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
