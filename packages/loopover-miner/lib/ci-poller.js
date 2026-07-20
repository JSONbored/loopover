import { fetchWithRetry } from "./http-retry.js";
const defaultApiBaseUrl = "https://api.github.com";
const defaultMinIntervalMs = 60_000;
const defaultMaxIntervalMs = 5 * 60_000;
const defaultMaxAttempts = 1;
const defaultRequestTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";
function normalizeApiBaseUrl(value) {
    if (value === undefined)
        return defaultApiBaseUrl;
    if (typeof value !== "string" || !value.trim())
        return defaultApiBaseUrl;
    let parsed;
    try {
        parsed = new URL(value.trim());
    }
    catch {
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
    if (!Number.isFinite(value))
        return fallback;
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
        requestTimeoutMs: normalizePositiveInt(options.requestTimeoutMs, defaultRequestTimeoutMs, 1, 60_000),
        sleepFn: options.sleepFn ??
            ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    };
}
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner?.trim() || !repo?.trim() || extra !== undefined) {
        throw new Error("invalid_repo_full_name");
    }
    return { owner: owner.trim(), repo: repo.trim() };
}
function normalizePullNumber(value) {
    if (!Number.isInteger(value) || value <= 0)
        throw new Error("invalid_pr_number");
    return value;
}
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": githubApiVersion,
    };
    if (githubToken)
        headers.authorization = `Bearer ${githubToken}`;
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
    const record = payload;
    const githubMessage = typeof record?.message === "string" && record.message.trim() ? record.message : null;
    const message = githubMessage ? `${code}: ${githubMessage}` : code;
    return Object.assign(new Error(message), { code, githubMessage });
}
async function githubGetJsonResponse(url, options) {
    // Retry transient network errors / 5xx around this single call (#4829), distinct from the poller's own
    // pending-retry loop; the poller's injected sleepFn keeps tests instant. requestTimeoutMs bounds each
    // individual attempt (a stalled connection previously hung this call forever -- #miner-github-read-timeouts).
    const response = (await fetchWithRetry(options.fetchFn, url, { method: "GET", headers: githubHeaders(options.githubToken) }, { sleepFn: options.sleepFn, timeoutMs: options.requestTimeoutMs }));
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
    if (!checkRun || typeof checkRun !== "object")
        return "pending";
    const run = checkRun;
    if (run.status !== "completed")
        return "pending";
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
function normalizeCheckRun(checkRun) {
    const run = checkRun;
    return {
        name: typeof run?.name === "string" ? run.name : "",
        status: typeof run?.status === "string" ? run.status : "unknown",
        conclusion: normalizeConclusion(checkRun),
        detailsUrl: typeof run?.details_url === "string" ? run.details_url : null,
        startedAt: typeof run?.started_at === "string" ? run.started_at : null,
        completedAt: typeof run?.completed_at === "string" ? run.completed_at : null,
    };
}
function aggregateConclusion(checks) {
    if (checks.length === 0)
        return "pending";
    if (checks.some((check) => check.conclusion === "failure"))
        return "failure";
    if (checks.some((check) => check.conclusion === "pending"))
        return "pending";
    if (checks.every((check) => check.conclusion === "success"))
        return "success";
    return "neutral";
}
function backoffDelayMs(attemptIndex, options) {
    const exponent = Math.min(10, Math.max(0, attemptIndex));
    return Math.min(options.maxIntervalMs, options.minIntervalMs * 2 ** exponent);
}
async function fetchHeadSha(target, prNumber, options) {
    const payload = (await githubGetJson(apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)), options));
    const headSha = payload?.head?.sha;
    if (typeof headSha !== "string" || !headSha)
        throw new Error("github_pr_head_sha_missing");
    return headSha;
}
async function fetchCheckRuns(target, headSha, options) {
    const checks = [];
    let page = 1;
    let expectedTotalCount = null;
    while (true) {
        const { payload, response } = await githubGetJsonResponse(apiUrl(options.apiBaseUrl, repoPath(target, `/commits/${encodeURIComponent(headSha)}/check-runs`), `?per_page=100&page=${page}`), options);
        const body = payload;
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
        if (attempt < normalizedOptions.maxAttempts - 1) {
            await normalizedOptions.sleepFn(backoffDelayMs(attempt, normalizedOptions));
        }
    }
    return latest;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2ktcG9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2ktcG9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQUVqRCxNQUFNLGlCQUFpQixHQUFHLHdCQUF3QixDQUFDO0FBQ25ELE1BQU0sb0JBQW9CLEdBQUcsTUFBTSxDQUFDO0FBQ3BDLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLGtCQUFrQixHQUFHLENBQUMsQ0FBQztBQUM3QixNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLGdCQUFnQixHQUFHLFlBQVksQ0FBQztBQTRDdEMsU0FBUyxtQkFBbUIsQ0FBQyxLQUFjO0lBQ3pDLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLGlCQUFpQixDQUFDO0lBQ2xELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRTtRQUFFLE9BQU8saUJBQWlCLENBQUM7SUFDekUsSUFBSSxNQUFXLENBQUM7SUFDaEIsSUFBSSxDQUFDO1FBQ0gsTUFBTSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxnQkFBZ0IsRUFBRSxDQUFDO1FBQ3pFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBQ0QsTUFBTSxDQUFDLFFBQVEsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUM7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