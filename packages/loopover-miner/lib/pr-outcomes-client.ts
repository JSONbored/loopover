/** Hosted-backend client for a contributor's post-merge PR-outcome history (#7658): a thin, FAIL-LOUD wrapper over
 * `GET /v1/contributors/:login/pr-outcomes` (`src/signals/contributor-pr-outcomes.ts`). Uses the same authenticated
 * loopover-mcp session posture (`resolveLoopoverBackendSession`) every other miner→hosted-API call uses, and throws
 * a clear Error on any failure (no configured session, unreachable host, non-2xx, malformed body) rather than
 * silently degrading -- the CLI on top turns each throw into a non-zero exit with the message. The endpoint is
 * self-scoped via `requireContributorAccess`, so this only ever surfaces the caller's own public-safe attribution
 * data (no reward/wallet fields). */
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** One merged-PR outcome as the endpoint reports it (mirrors ContributorPrOutcome in contributor-pr-outcomes.ts). */
export type ContributorPrOutcome = {
  repoFullName: string;
  pullNumber: number | null;
  outcome: "merged";
  attribution: string;
  deeplink: string;
  recordedAt: string;
};

/** The endpoint's full payload (mirrors ContributorPrOutcomes). */
export type ContributorPrOutcomes = {
  login: string;
  count: number;
  summary: string;
  outcomes: ContributorPrOutcome[];
};

export type FetchContributorPrOutcomesOptions = {
  /** Read for the loopover-mcp session + API URL -- defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injected fetch, so tests drive the client without a real backend; defaults to the real global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Cap merged-PR rows the endpoint returns (1..100); omitted lets the endpoint apply its own default. */
  limit?: number;
  requestTimeoutMs?: number;
};

/**
 * Fetch `login`'s post-merge PR-outcome history from the hosted backend. Requires an authenticated loopover-mcp
 * session (throws `no_loopover_session` otherwise, matching the endpoint's self-scoped access). `limit`, when given,
 * must be an integer in 1..100 -- the same bound the endpoint enforces -- else this throws before any network call.
 */
export async function fetchContributorPrOutcomes(
  login: string,
  options: FetchContributorPrOutcomesOptions = {},
): Promise<ContributorPrOutcomes> {
  const normalizedLogin = typeof login === "string" ? login.trim() : "";
  if (!normalizedLogin) throw new Error("pr-outcomes requires a non-empty login");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
    throw new Error("pr-outcomes limit must be an integer between 1 and 100");
  }

  const session = resolveLoopoverBackendSession(options.env ?? process.env);
  if (!session) throw new Error("no_loopover_session: run `loopover-mcp login` first");

  const fetchImpl = options.fetchImpl ?? (fetch as (url: string, init: RequestInit) => Promise<Response>);
  const timeoutMs = Number.isFinite(options.requestTimeoutMs) ? (options.requestTimeoutMs as number) : DEFAULT_REQUEST_TIMEOUT_MS;
  const query = options.limit !== undefined ? `?limit=${options.limit}` : "";
  const path = `/v1/contributors/${encodeURIComponent(normalizedLogin)}/pr-outcomes${query}`;

  let response: Response;
  try {
    response = await fetchImpl(`${session.apiUrl}${path}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${session.sessionToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`pr-outcomes endpoint unreachable for ${normalizedLogin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`pr-outcomes endpoint returned http_${response.status} for ${normalizedLogin}`);
  }
  const payload = (await response.json().catch(() => null)) as ContributorPrOutcomes | null;
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.outcomes)) {
    throw new Error(`pr-outcomes endpoint returned a malformed response for ${normalizedLogin}`);
  }
  return payload;
}
