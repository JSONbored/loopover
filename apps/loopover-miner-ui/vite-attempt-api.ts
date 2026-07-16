import type { Plugin } from "vite";

import type { AttemptCliResult, RunAttemptOptions } from "../../packages/loopover-miner/lib/attempt-cli.js";

// `attempt` action-dispatch surface for the miner-ui (#6522): the sibling of vite-discover-api.ts, and the
// first HTTP route driving the miner's real coding-agent write path. Until now `attempt` existed only as a CLI
// subcommand (bin/loopover-miner.js -> runAttempt). This file is a thin bridge to the EXISTING, unmodified
// `runAttempt` entry point (packages/loopover-miner/lib/attempt-cli.js) -- it marshals a POST JSON body into the
// same CLI-style `args: string[]` parseAttemptArgs already accepts, calls runAttempt, and marshals its
// structured result back out. It does NOT reimplement the worktree / coding-agent / chokepoint pipeline: because
// it calls the real runAttempt, it inherits the full Governor chokepoint gate (kill-switch -> dry-run ->
// rate-limit -> budget -> non-convergence -> self-reputation -> self-plagiarism) for free, with no bypass path.
//
// Structured result capture: runAttempt already fires `options.onResult` with the real structured result at
// every genuine return point (dry-run, rejected, worktree-failure, infeasible, blocked, final) — never at its
// three reportCliFailure sites (parse-error, paused, unexpected-error). This route captures that result and, on
// a captured outcome, returns it (plus the raw exit code, so a caller can tell a governed rejection/paused
// outcome from a clean success without re-deriving it). When runAttempt returns non-zero WITHOUT ever firing
// onResult, there is no structured result — the route responds with a clear error status instead of crashing.
//
// Runtime: unlike every existing /api/* route (all synchronous local-store reads/writes), /api/attempt may run
// for MINUTES — it drives a full worktree checkout + coding-agent iteration. This handler imposes no artificial
// per-request timeout; it simply awaits the real runAttempt.
//
// Auth: like every sibling /api/* route this file is registered AFTER authPlugin() in vite.config.ts's plugin
// list, so vite-auth.ts's cookie gate covers it automatically. No credential is ever read from the request
// body: the miner's local harness runs writes with its own local credentials (GITHUB_TOKEN / resolveGitHubToken
// live session), never a caller-supplied one. Only non-secret passthrough fields (owner/repo, issue number,
// minerLogin, base, live, dryRun, json) are marshaled into the args array.

type AttemptCliModule = {
  runAttempt: (args: string[], options?: RunAttemptOptions) => Promise<number>;
};

export type AttemptApiDeps = {
  /** Import of `packages/loopover-miner/lib/attempt-cli.js` — injectable so tests never touch a real store,
   *  worktree, coding agent, or network. */
  loadAttemptCliModule: () => Promise<AttemptCliModule>;
};

const defaultDeps: AttemptApiDeps = {
  loadAttemptCliModule: () => import("../../packages/loopover-miner/lib/attempt-cli.js") as Promise<AttemptCliModule>,
};

/** The non-secret subset of a `/api/attempt` POST body. A caller-supplied `githubToken`/`token`/`apiKey` field
 *  is never in this shape and is dropped, not threaded through — credentials are resolved server-side only. */
type AttemptRequestBody = {
  repoFullName: string;
  issueNumber: number;
  minerLogin?: string;
  base?: string;
  live: boolean;
  dryRun: boolean;
  json: boolean;
};

export type AttemptRoute = "attempt-post";

/** Pure route matcher, no I/O — safe to call synchronously before deciding whether to read a request body. */
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

/** Parses the POST body into the non-secret attempt request shape, or null for a malformed / missing-required
 *  body (no repo target, or a non-positive-integer issue number). Mirrors parseActionBody: a malformed body
 *  never reaches runAttempt at all. */
function parseAttemptBody(rawBody: string): AttemptRequestBody | null {
  if (!rawBody.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const repoFullName =
    typeof record.repoFullName === "string" && record.repoFullName.trim() ? record.repoFullName.trim() : null;
  if (!repoFullName) return null;
  const issueNumber = record.issueNumber;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;
  const body: AttemptRequestBody = {
    repoFullName,
    issueNumber,
    live: record.live === true,
    dryRun: record.dryRun === true,
    json: record.json === true,
  };
  if (typeof record.minerLogin === "string" && record.minerLogin.trim()) body.minerLogin = record.minerLogin.trim();
  if (typeof record.base === "string" && record.base.trim()) body.base = record.base.trim();
  return body;
}

/** Builds the CLI-style args array parseAttemptArgs accepts from the parsed body — the only entry point into
 *  runAttempt is a `string[]`, so the route constructs argv rather than calling a lower-level structured API. */
function buildAttemptArgs(body: AttemptRequestBody): string[] {
  const args = [body.repoFullName, String(body.issueNumber)];
  if (body.minerLogin !== undefined) args.push("--miner-login", body.minerLogin);
  if (body.base !== undefined) args.push("--base", body.base);
  if (body.live) args.push("--live");
  if (body.dryRun) args.push("--dry-run");
  if (body.json) args.push("--json");
  return args;
}

async function respondToAttemptRoute(rawBody: string, deps: AttemptApiDeps): Promise<{ status: number; body: string }> {
  const body = parseAttemptBody(rawBody);
  if (!body) {
    return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };
  }
  try {
    const attemptCli = await deps.loadAttemptCliModule();
    let captured: AttemptCliResult | undefined;
    // No artificial timeout: /api/attempt legitimately runs for minutes (worktree + coding-agent iteration).
    const exitCode = await attemptCli.runAttempt(buildAttemptArgs(body), {
      onResult: (result) => {
        captured = result;
      },
    });
    if (captured !== undefined) {
      return { status: 200, body: JSON.stringify({ result: captured, exitCode }) };
    }
    // Exit-code-only branch: runAttempt returned non-zero (a reportCliFailure site — parse-error / paused /
    // unexpected-error) WITHOUT ever firing onResult, so there is no structured result. Respond with a clear
    // error status carrying the raw exit code rather than crashing on an assumed-present result object.
    return { status: 502, body: JSON.stringify({ error: "attempt_failed", exitCode }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to run local attempt";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Request handler factored out for direct unit tests (mirrors vite-governor-api.ts's handleGovernorRequest).
 *  Returns null when the request is not for the attempt route (caller falls through). */
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

/** Vite dev/preview middleware serving the POST /api/attempt action route. */
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
