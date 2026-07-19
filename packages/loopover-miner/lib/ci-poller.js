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
    const response = await fetchWithRetry(options.fetchFn, url, { method: "GET", headers: githubHeaders(options.githubToken) }, { sleepFn: options.sleepFn, timeoutMs: options.requestTimeoutMs });
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
    const record = payload;
    const totalCount = Number(record?.total_count);
    return Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : null;
}
function normalizeConclusion(checkRun) {
    if (!checkRun || typeof checkRun !== "object")
        return "pending";
    const record = checkRun;
    if (record.status !== "completed")
        return "pending";
    switch (record.conclusion) {
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
    const record = checkRun;
    return {
        name: typeof record?.name === "string" ? record.name : "",
        status: typeof record?.status === "string" ? record.status : "unknown",
        conclusion: normalizeConclusion(checkRun),
        detailsUrl: typeof record?.details_url === "string" ? record.details_url : null,
        startedAt: typeof record?.started_at === "string" ? record.started_at : null,
        completedAt: typeof record?.completed_at === "string" ? record.completed_at : null,
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
    const payload = await githubGetJson(apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)), options);
    const record = payload;
    const headSha = record?.head?.sha;
    if (typeof headSha !== "string" || !headSha)
        throw new Error("github_pr_head_sha_missing");
    return headSha;
}
async function fetchCheckRuns(target, headSha, options) {
    const checks = [];
    let page = 1;
    let expectedTotalCount = null;
    for (;;) {
        const { payload, response } = await githubGetJsonResponse(apiUrl(options.apiBaseUrl, repoPath(target, `/commits/${encodeURIComponent(headSha)}/check-runs`), `?per_page=100&page=${page}`), options);
        const record = payload;
        if (!Array.isArray(record?.check_runs)) {
            throw new Error("github_check_runs_malformed");
        }
        const pageChecks = record.check_runs.map(normalizeCheckRun);
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
    // Unreachable at runtime: normalizeOptions clamps maxAttempts to a minimum of 1 (normalizePositiveInt's own
    // `min` argument), so the loop above always returns internally on its final iteration (line 267 or 277).
    // Kept only because TypeScript's control-flow analysis can't see that runtime guarantee through the loop.
    return latest;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2ktcG9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2ktcG9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQTBDakQsTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCxNQUFNLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUNwQyxNQUFNLG9CQUFvQixHQUFHLENBQUMsR0FBRyxNQUFNLENBQUM7QUFDeEMsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUM7QUFDN0IsTUFBTSx1QkFBdUIsR0FBRyxNQUFNLENBQUM7QUFDdkMsTUFBTSxnQkFBZ0IsR0FBRyxZQUFZLENBQUM7QUFFdEMsU0FBUyxtQkFBbUIsQ0FBQyxLQUF5QjtJQUNwRCxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxpQkFBaUIsQ0FBQztJQUNsRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUU7UUFBRSxPQUFPLGlCQUFpQixDQUFDO0lBQ3pFLElBQUksTUFBVyxDQUFDO0lBQ2hCLElBQUksQ0FBQztRQUNILE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNqQyxDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsTUFBTSxJQUFJLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxDQUFDO0lBQzFDLENBQUM7SUFDRCxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxRQUFRLEtBQUssZ0JBQWdCLEVBQUUsQ0FBQztRQUN6RSxNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELE1BQU0sQ0FBQyxRQUFRLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxDQUFD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