// Real PR-disposition poller (#5135, Wave 3.5 -- the autonomous loop). ci-poller.js already polls a PR's CI
// check-runs, but that answers a DIFFERENT question ("did the checks pass") from what the supervising loop
// needs at cycle-close time ("did the PR itself get merged or closed"). Nothing in this package answered that
// second question before this file: pr-outcome.js already has a real store for the classification
// (recordPrOutcomeSnapshot/readPrOutcomes), but every existing caller of it was a test -- this is the real
// GitHub fetch that produces the classification pr-outcome.js's writer expects.
//
// Deliberately its own module, not folded into ci-poller.js: the two pollers ask genuinely different
// questions (check-run conclusion vs. PR merge/close disposition) with different terminal conditions (a
// check-run poll's "pending" means "wait for the SAME head commit's checks to finish"; a disposition poll's
// "open" means "wait for a human to actually merge or close the PR", a potentially much longer, unbounded
// wait) -- composing them into one poller would conflate two different backoff/timeout policies.

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

function apiUrl(apiBaseUrl, path) {
  return `${apiBaseUrl}${path}`;
}

function githubError(response, payload) {
  const code = `github_${response.status}`;
  const githubMessage =
    typeof payload?.message === "string" && payload.message.trim() ? payload.message : null;
  const message = githubMessage ? `${code}: ${githubMessage}` : code;
  return Object.assign(new Error(message), { code, githubMessage });
}

async function fetchPullRequest(target, prNumber, options) {
  const response = await options.fetchFn(apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)), {
    method: "GET",
    headers: githubHeaders(options.githubToken),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw githubError(response, payload);
  return payload;
}

/** GitHub's own vocabulary is `state: "open"|"closed"` plus a separate `merged: boolean` -- "closed and not
 *  merged" is the disengaged case. A still-open PR is never terminal for this poller's purposes. */
function normalizeDisposition(payload) {
  const state = payload?.state === "closed" ? "closed" : "open";
  const merged = Boolean(payload?.merged);
  const closedAt = typeof payload?.closed_at === "string" ? payload.closed_at : null;
  return { state, merged, closedAt };
}

function backoffDelayMs(attemptIndex, options) {
  const exponent = Math.min(10, Math.max(0, attemptIndex));
  return Math.min(options.maxIntervalMs, options.minIntervalMs * 2 ** exponent);
}

/**
 * Poll a real PR's own merge/close disposition (distinct from its CI check-run conclusion, ci-poller.js's
 * concern) with exponential backoff, until it reaches a terminal `state: "closed"` or `maxAttempts` is
 * exhausted -- whichever comes first. A still-`"open"` PR after the last attempt is returned as-is, not an
 * error: an unattended loop cycle should treat "still open" as "not yet resolved", not fail.
 *
 * @param {string} repoFullName
 * @param {number} prNumber
 * @param {{
 *   apiBaseUrl?: string, fetchFn?: typeof fetch, githubToken?: string, maxAttempts?: number,
 *   minIntervalMs?: number, maxIntervalMs?: number, sleepFn?: (delayMs: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<{ state: "open"|"closed", merged: boolean, closedAt: string|null, attempts: number }>}
 */
export async function pollPrDisposition(repoFullName, prNumber, options = {}) {
  const target = parseRepoFullName(repoFullName);
  const normalizedPrNumber = normalizePullNumber(prNumber);
  const normalizedOptions = normalizeOptions(options);

  let latest = { state: "open", merged: false, closedAt: null, attempts: 0 };
  for (let attempt = 0; attempt < normalizedOptions.maxAttempts; attempt += 1) {
    const payload = await fetchPullRequest(target, normalizedPrNumber, normalizedOptions);
    latest = { ...normalizeDisposition(payload), attempts: attempt + 1 };
    if (latest.state === "closed") return latest;
    if (attempt === normalizedOptions.maxAttempts - 1) return latest;
    await normalizedOptions.sleepFn(backoffDelayMs(attempt, normalizedOptions));
  }
  return latest;
}

/**
 * Classify a real, terminal PR disposition into loop-reentry.js's own `candidate.outcome` vocabulary
 * (`"merged"|"disengaged"|"other"`). A still-open disposition (not yet resolved) classifies as `"other"` --
 * the same bucket a runMinerAttempt outcome that never opened a PR at all falls into (nothing to re-enter on
 * yet, in either case).
 *
 * @param {{ state: "open"|"closed", merged: boolean }} disposition
 * @returns {"merged"|"disengaged"|"other"}
 */
export function classifyPrDisposition(disposition) {
  if (disposition.state !== "closed") return "other";
  return disposition.merged ? "merged" : "disengaged";
}
