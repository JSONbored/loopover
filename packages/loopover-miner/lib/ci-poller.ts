import { fetchWithRetry } from "./http-retry.js";

const defaultApiBaseUrl = "https://api.github.com";
const defaultMinIntervalMs = 60_000;
const defaultMaxIntervalMs = 5 * 60_000;
const defaultMaxAttempts = 1;
const defaultRequestTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";

export type CheckRunConclusion = "pending" | "success" | "failure" | "neutral";

export type NormalizedCheckRun = {
  name: string;
  status: string;
  conclusion: CheckRunConclusion;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PollCheckRunsResult = {
  conclusion: CheckRunConclusion;
  checks: NormalizedCheckRun[];
  headSha: string;
  attempts: number;
};

export type PollCheckRunsOptions = {
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  githubToken?: string;
  maxAttempts?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  requestTimeoutMs?: number;
  sleepFn?: (delayMs: number) => Promise<unknown>;
};

type NormalizedPollOptions = {
  apiBaseUrl: string;
  fetchFn: typeof fetch;
  githubToken: string;
  maxAttempts: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  requestTimeoutMs: number;
  sleepFn: (delayMs: number) => Promise<unknown>;
};

type RepoTarget = { owner: string; repo: string };

function normalizeApiBaseUrl(value: unknown): string {
  if (value === undefined) return defaultApiBaseUrl;
  if (typeof value !== "string" || !value.trim()) return defaultApiBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("invalid_api_base_url");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
    throw new Error("invalid_api_base_url");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value as number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function normalizeOptions(options: PollCheckRunsOptions = {}): NormalizedPollOptions {
  return {
    apiBaseUrl: normalizeApiBaseUrl(options.apiBaseUrl),
    fetchFn: options.fetchFn ?? fetch,
    githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : "",
    maxAttempts: normalizePositiveInt(options.maxAttempts, defaultMaxAttempts, 1, 20),
    minIntervalMs: normalizePositiveInt(options.minIntervalMs, defaultMinIntervalMs, 1, 60 * 60_000),
    maxIntervalMs: normalizePositiveInt(options.maxIntervalMs, defaultMaxIntervalMs, 1, 60 * 60_000),
    requestTimeoutMs: normalizePositiveInt(options.requestTimeoutMs, defaultRequestTimeoutMs, 1, 60_000),
    sleepFn:
      options.sleepFn ??
      ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs))),
  };
}

function parseRepoFullName(repoFullName: string): RepoTarget {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner?.trim() || !repo?.trim() || extra !== undefined) {
    throw new Error("invalid_repo_full_name");
  }
  return { owner: owner.trim(), repo: repo.trim() };
}

function normalizePullNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("invalid_pr_number");
  return value;
}

function githubHeaders(githubToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": githubApiVersion,
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return headers;
}

function repoPath(target: RepoTarget, suffix: string): string {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}

function apiUrl(apiBaseUrl: string, path: string, query = ""): string {
  return `${apiBaseUrl}${path}${query}`;
}

function githubError(response: { status: number }, payload: unknown): Error {
  const code = `github_${response.status}`;
  const record = payload as { message?: unknown } | null;
  const githubMessage =
    typeof record?.message === "string" && record.message.trim() ? record.message : null;
  const message = githubMessage ? `${code}: ${githubMessage}` : code;
  return Object.assign(new Error(message), { code, githubMessage });
}

async function githubGetJsonResponse(
  url: string,
  options: NormalizedPollOptions,
): Promise<{ payload: unknown; response: Response }> {
  // Retry transient network errors / 5xx around this single call (#4829), distinct from the poller's own
  // pending-retry loop; the poller's injected sleepFn keeps tests instant. requestTimeoutMs bounds each
  // individual attempt (a stalled connection previously hung this call forever -- #miner-github-read-timeouts).
  const response = (await fetchWithRetry(
    options.fetchFn as Parameters<typeof fetchWithRetry>[0],
    url,
    { method: "GET", headers: githubHeaders(options.githubToken) },
    { sleepFn: options.sleepFn, timeoutMs: options.requestTimeoutMs },
  )) as Response;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw githubError(response, payload);
  }
  return { payload, response };
}

async function githubGetJson(url: string, options: NormalizedPollOptions): Promise<unknown> {
  const { payload } = await githubGetJsonResponse(url, options);
  return payload;
}

function hasNextLink(response: Response): boolean {
  return /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
}

function payloadTotalCount(payload: unknown): number | null {
  const totalCount = Number((payload as { total_count?: unknown } | null)?.total_count);
  return Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null;
}

function normalizeConclusion(checkRun: unknown): CheckRunConclusion {
  if (!checkRun || typeof checkRun !== "object") return "pending";
  const run = checkRun as { status?: unknown; conclusion?: unknown };
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "skipped":
      return "success";
    case "neutral":
      return "neutral";
    case "failure":
    case "cancelled":
    case "timed_out":
    case "action_required":
    case "stale":
    case "startup_failure":
      return "failure";
    default:
      return "pending";
  }
}

function normalizeCheckRun(checkRun: unknown): NormalizedCheckRun {
  const run = checkRun as {
    name?: unknown;
    status?: unknown;
    details_url?: unknown;
    started_at?: unknown;
    completed_at?: unknown;
  } | null;
  return {
    name: typeof run?.name === "string" ? run.name : "",
    status: typeof run?.status === "string" ? run.status : "unknown",
    conclusion: normalizeConclusion(checkRun),
    detailsUrl: typeof run?.details_url === "string" ? run.details_url : null,
    startedAt: typeof run?.started_at === "string" ? run.started_at : null,
    completedAt: typeof run?.completed_at === "string" ? run.completed_at : null,
  };
}

function aggregateConclusion(checks: NormalizedCheckRun[]): CheckRunConclusion {
  if (checks.length === 0) return "pending";
  if (checks.some((check) => check.conclusion === "failure")) return "failure";
  if (checks.some((check) => check.conclusion === "pending")) return "pending";
  if (checks.every((check) => check.conclusion === "success")) return "success";
  return "neutral";
}

function backoffDelayMs(attemptIndex: number, options: NormalizedPollOptions): number {
  const exponent = Math.min(10, Math.max(0, attemptIndex));
  return Math.min(options.maxIntervalMs, options.minIntervalMs * 2 ** exponent);
}

async function fetchHeadSha(target: RepoTarget, prNumber: number, options: NormalizedPollOptions): Promise<string> {
  const payload = (await githubGetJson(
    apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)),
    options,
  )) as { head?: { sha?: unknown } } | null;
  const headSha = payload?.head?.sha;
  if (typeof headSha !== "string" || !headSha) throw new Error("github_pr_head_sha_missing");
  return headSha;
}

async function fetchCheckRuns(
  target: RepoTarget,
  headSha: string,
  options: NormalizedPollOptions,
): Promise<NormalizedCheckRun[]> {
  const checks: NormalizedCheckRun[] = [];
  let page = 1;
  let expectedTotalCount: number | null = null;
  while (true) {
    const { payload, response } = await githubGetJsonResponse(
      apiUrl(
        options.apiBaseUrl,
        repoPath(target, `/commits/${encodeURIComponent(headSha)}/check-runs`),
        `?per_page=100&page=${page}`,
      ),
      options,
    );
    const body = payload as { check_runs?: unknown } | null;
    if (!Array.isArray(body?.check_runs)) {
      throw new Error("github_check_runs_malformed");
    }
    const pageChecks = body.check_runs.map(normalizeCheckRun);
    checks.push(...pageChecks);
    expectedTotalCount = payloadTotalCount(payload) ?? expectedTotalCount;
    if (!hasNextLink(response) && (expectedTotalCount === null || checks.length >= expectedTotalCount)) {
      return checks;
    }
    if (pageChecks.length === 0) {
      throw new Error("github_check_runs_pagination_incomplete");
    }
    page += 1;
  }
}

export async function pollCheckRuns(
  repoFullName: string,
  prNumber: number,
  options: PollCheckRunsOptions = {},
): Promise<PollCheckRunsResult> {
  const target = parseRepoFullName(repoFullName);
  const normalizedPrNumber = normalizePullNumber(prNumber);
  const normalizedOptions = normalizeOptions(options);

  let latest: PollCheckRunsResult = { conclusion: "pending", checks: [], headSha: "", attempts: 0 };
  for (let attempt = 0; attempt < normalizedOptions.maxAttempts; attempt += 1) {
    const headSha = await fetchHeadSha(target, normalizedPrNumber, normalizedOptions);
    const checks = await fetchCheckRuns(target, headSha, normalizedOptions);
    latest = {
      conclusion: aggregateConclusion(checks),
      checks,
      headSha,
      attempts: attempt + 1,
    };
    if (latest.conclusion !== "pending") {
      const currentHeadSha = await fetchHeadSha(target, normalizedPrNumber, normalizedOptions);
      if (currentHeadSha === headSha) {
        return latest;
      }
      latest = {
        conclusion: "pending",
        checks: [],
        headSha: currentHeadSha,
        attempts: attempt + 1,
      };
    }
    if (attempt < normalizedOptions.maxAttempts - 1) {
      await normalizedOptions.sleepFn(backoffDelayMs(attempt, normalizedOptions));
    }
  }

  return latest;
}
