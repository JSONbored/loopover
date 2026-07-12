import { fetchWithRetry } from "./http-retry.js";

const defaultApiBaseUrl = "https://api.github.com";
const defaultMinIntervalMs = 60_000;
const defaultMaxIntervalMs = 5 * 60_000;
const defaultMaxAttempts = 1;
const githubApiVersion = "2022-11-28";

function normalizeApiBaseUrl(value) {
  if (value === undefined) return defaultApiBaseUrl;
  if (typeof value !== "string" || !value.trim()) return defaultApiBaseUrl;
  let parsed;
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

function normalizePositiveInt(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeOptions(options = {}) {
  return {
    apiBaseUrl: normalizeApiBaseUrl(options.apiBaseUrl),
    fetchFn: options.fetchFn ?? fetch,
    githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : "",
    maxAttempts: normalizePositiveInt(options.maxAttempts, defaultMaxAttempts, 1, 20),
    minIntervalMs: normalizePositiveInt(options.minIntervalMs, defaultMinIntervalMs, 1, 60 * 60_000),
    maxIntervalMs: normalizePositiveInt(options.maxIntervalMs, defaultMaxIntervalMs, 1, 60 * 60_000),
    sleepFn:
      options.sleepFn ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
  };
}

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") throw new Error("invalid_repo_full_name");
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner?.trim() || !repo?.trim() || extra !== undefined) {
    throw new Error("invalid_repo_full_name");
  }
  return { owner: owner.trim(), repo: repo.trim() };
}

function normalizePullNumber(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error("invalid_pr_number");
  return value;
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": githubApiVersion,
  };
  if (githubToken) headers.authorization = `Bearer ${githubToken}`;
  return headers;
}

function repoPath(target, suffix) {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}

function apiUrl(apiBaseUrl, path, query = "") {
  return `${apiBaseUrl}${path}${query}`;
}

function githubError(response, payload) {
  const code = `github_${response.status}`;
  const githubMessage =
    typeof payload?.message === "string" && payload.message.trim() ? payload.message : null;
  const message = githubMessage ? `${code}: ${githubMessage}` : code;
  return Object.assign(new Error(message), { code, githubMessage });
}

async function githubGetJsonResponse(url, options) {
  // Retry transient network errors / 5xx around this single call (#4829), distinct from the poller's own
  // pending-retry loop; the poller's injected sleepFn keeps tests instant.
  const response = await fetchWithRetry(
    options.fetchFn,
    url,
    { method: "GET", headers: githubHeaders(options.githubToken) },
    { sleepFn: options.sleepFn },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw githubError(response, payload);
  }
  return { payload, response };
}

async function githubGetJson(url, options) {
  const { payload } = await githubGetJsonResponse(url, options);
  return payload;
}

function hasNextLink(response) {
  return /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
}

function payloadTotalCount(payload) {
  const totalCount = Number(payload?.total_count);
  return Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null;
}

function normalizeConclusion(checkRun) {
  if (!checkRun || typeof checkRun !== "object") return "pending";
  if (checkRun.status !== "completed") return "pending";
  switch (checkRun.conclusion) {
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

function normalizeCheckRun(checkRun) {
  return {
    name: typeof checkRun?.name === "string" ? checkRun.name : "",
    status: typeof checkRun?.status === "string" ? checkRun.status : "unknown",
    conclusion: normalizeConclusion(checkRun),
    detailsUrl: typeof checkRun?.details_url === "string" ? checkRun.details_url : null,
    startedAt: typeof checkRun?.started_at === "string" ? checkRun.started_at : null,
    completedAt: typeof checkRun?.completed_at === "string" ? checkRun.completed_at : null,
  };
}

function aggregateConclusion(checks) {
  if (checks.length === 0) return "pending";
  if (checks.some((check) => check.conclusion === "failure")) return "failure";
  if (checks.some((check) => check.conclusion === "pending")) return "pending";
  if (checks.every((check) => check.conclusion === "success")) return "success";
  return "neutral";
}

function backoffDelayMs(attemptIndex, options) {
  const exponent = Math.min(10, Math.max(0, attemptIndex));
  return Math.min(options.maxIntervalMs, options.minIntervalMs * 2 ** exponent);
}

async function fetchHeadSha(target, prNumber, options) {
  const payload = await githubGetJson(
    apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)),
    options,
  );
  const headSha = payload?.head?.sha;
  if (typeof headSha !== "string" || !headSha) throw new Error("github_pr_head_sha_missing");
  return headSha;
}

async function fetchCheckRuns(target, headSha, options) {
  const checks = [];
  let page = 1;
  let expectedTotalCount = null;
  while (true) {
    const { payload, response } = await githubGetJsonResponse(
      apiUrl(
        options.apiBaseUrl,
        repoPath(target, `/commits/${encodeURIComponent(headSha)}/check-runs`),
        `?per_page=100&page=${page}`,
      ),
      options,
    );
    if (!Array.isArray(payload?.check_runs)) {
      throw new Error("github_check_runs_malformed");
    }
    const pageChecks = payload.check_runs.map(normalizeCheckRun);
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

export async function pollCheckRuns(repoFullName, prNumber, options = {}) {
  const target = parseRepoFullName(repoFullName);
  const normalizedPrNumber = normalizePullNumber(prNumber);
  const normalizedOptions = normalizeOptions(options);

  let latest = { conclusion: "pending", checks: [], headSha: "", attempts: 0 };
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
    if (attempt === normalizedOptions.maxAttempts - 1) {
      return latest;
    }
    await normalizedOptions.sleepFn(backoffDelayMs(attempt, normalizedOptions));
  }

  return latest;
}
