// `loopover-miner pr-outcomes --miner-login <login> [--limit <n>] [--json]` (#7658): read-only report of the
// miner's own hosted post-merge outcome history. Calls the hosted `GET /v1/contributors/:login/pr-outcomes`
// (src/signals/contributor-pr-outcomes.ts — public-safe attribution only, no reward/wallet fields) using the
// same loopover-mcp session + API URL posture the other backend calls in this package use
// (resolveLoopoverBackendSession, #6487). Thin composition layer like tenant-cli.js: argv parsing plus one
// authenticated GET; every failure (no session, unreachable host, non-2xx, malformed body) is reported as a
// non-zero exit with a visible message — reading your own outcome history is a deliberate action whose
// failure the miner must see, so there is deliberately no silent-degrade path.
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

const PR_OUTCOMES_USAGE = "Usage: loopover-miner pr-outcomes --miner-login <login> [--limit <n>] [--json]";
// Matches the route's own AbortSignal-based read timeouts elsewhere in this package (self-review-context.js).
const PR_OUTCOMES_TIMEOUT_MS = 10_000;

export type ParsedPrOutcomesArgs = { minerLogin: string; limit: number | null; json: boolean } | { error: string };

/** One hosted outcome row, as `GET /v1/contributors/:login/pr-outcomes` returns it. */
export type PrOutcomeRow = {
  repoFullName: string;
  pullNumber: number | null;
  outcome: string;
  attribution: string;
  deeplink: string;
  recordedAt: string;
};

export type PrOutcomesPayload = {
  login: string;
  count: number;
  summary: string;
  outcomes: PrOutcomeRow[];
};

// A narrower shape than `typeof fetch` on purpose: this command only ever issues a plain GET with headers and
// a signal, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored — same
// rationale as self-review-context.js's own SelfReviewContextFetch.
export type PrOutcomesFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export type RunPrOutcomesOptions = {
  /** Read for the loopover-mcp session/config resolution — defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch so tests drive the CLI without a live backend; defaults to the real global fetch. */
  fetchImpl?: PrOutcomesFetch;
  /** Injectable session resolver so tests exercise the CLI without a config file on disk. */
  resolveSession?: typeof resolveLoopoverBackendSession;
};

/** Parse `pr-outcomes --miner-login <login> [--limit <n>] [--json]`. Returns the parsed args or `{ error }`.
 *  `--limit` mirrors the route's own `?limit` validation (an integer between 1 and 100) so a bad value fails
 *  here with a clear message instead of as an HTTP 400 round-trip. */
export function parsePrOutcomesArgs(args: string[]): ParsedPrOutcomesArgs {
  let minerLogin: string | null = null;
  let limit: number | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--miner-login") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: `--miner-login requires a value. ${PR_OUTCOMES_USAGE}` };
      minerLogin = value;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const value = args[index + 1];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        return { error: `--limit must be an integer between 1 and 100. ${PR_OUTCOMES_USAGE}` };
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}. ${PR_OUTCOMES_USAGE}` };
    return { error: `Unexpected argument: ${token}. ${PR_OUTCOMES_USAGE}` };
  }
  if (minerLogin === null) return { error: `--miner-login is required. ${PR_OUTCOMES_USAGE}` };
  return { minerLogin, limit, json };
}

/** Render the text view: the payload's own summary line, then one line per outcome (newest first, as the
 *  route returns them). A `pullNumber` can be null for an older delivery row — rendered as the repo alone. */
export function renderPrOutcomesText(payload: PrOutcomesPayload): string {
  const lines = [payload.summary];
  for (const outcome of payload.outcomes) {
    const target = outcome.pullNumber === null ? outcome.repoFullName : `${outcome.repoFullName}#${outcome.pullNumber}`;
    lines.push(`- ${target} ${outcome.outcome} ${outcome.recordedAt} ${outcome.deeplink}`);
  }
  return lines.join("\n");
}

/**
 * Run `loopover-miner pr-outcomes --miner-login <login> [--limit <n>] [--json]`. Fetches the miner's own
 * hosted post-merge outcomes and prints them (a JSON dump under `--json`, else a text summary). Returns the
 * process exit code: 0 on success, 1 on a usage error, 2 on a session/HTTP/network failure.
 */
export async function runPrOutcomesCli(args: string[] = [], options: RunPrOutcomesOptions = {}): Promise<number> {
  const parsed = parsePrOutcomesArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error, 1);
  }
  const resolveSession = options.resolveSession ?? resolveLoopoverBackendSession;
  const session = resolveSession(options.env ?? process.env);
  if (!session) {
    return reportCliFailure(
      parsed.json,
      "No LoopOver session found — run `loopover-mcp login` first so pr-outcomes can read your own hosted outcome history.",
    );
  }
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as PrOutcomesFetch);
  const query = parsed.limit === null ? "" : `?limit=${parsed.limit}`;
  const url = `${session.apiUrl}/v1/contributors/${encodeURIComponent(parsed.minerLogin)}/pr-outcomes${query}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${session.sessionToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(PR_OUTCOMES_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      return reportCliFailure(parsed.json, `pr-outcomes request failed (HTTP ${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as PrOutcomesPayload;
    if (parsed.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(renderPrOutcomesText(payload));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}
