import { buildCollisionReport, MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent } from "@jsonbored/gittensory-engine";

// Real SelfReviewContext fetcher (#5145, Wave 3.5). Builds the context object the miner's self-review pass
// (packages/gittensory-engine/src/miner/self-review-adapter.ts) needs, at the SAME fidelity the live gate's
// own DB-backed construction produces (src/db/repositories.ts's toRepositoryRecord/toIssueRecord/
// toPullRequestRecord) -- just built fresh from live GitHub data instead of a DB round-trip, since the miner
// has no database. Two of SelfReviewContext's eight fields are DELIBERATELY left undefined, not stubbed:
//
//   - `bounties`: bounty data is not GitHub-native in this codebase -- it comes from an external "Gitt"
//     system that PUSHES data into the live gate's own internal ingest route (src/api/routes.ts). There is
//     no public endpoint the miner could legitimately pull from instead.
//   - `issueQuality`: built by buildIssueQualityReport, which lives only in root src/signals/engine.ts and
//     has never been extracted into @jsonbored/gittensory-engine (the same "not yet extracted" situation
//     src/signals/slop.ts documented before #5133 extracted slop scoring specifically).
//
// Both are already optional on SelfReviewContext, and buildPredictedGateVerdict already degrades gracefully
// without them -- omitting them here is the same tradeoff the live gate itself makes for a repo it hasn't
// computed bounty/quality data for yet, not a corner cut specific to the miner.

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const DEFAULT_GITTENSOR_API_BASE = "https://api.gittensor.io";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;

// Mirrors src/signals/focus-manifest-loader.ts's MANIFEST_FILE_CANDIDATES exactly -- first candidate that
// resolves wins, same as the live gate's own lookup order.
const MANIFEST_FILE_CANDIDATES = [".gittensory.yml", ".github/gittensory.yml", ".gittensory.json", ".github/gittensory.json"];

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory-miner",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function normalizeOptions(options = {}) {
  return {
    githubToken: options.githubToken ?? process.env.GITHUB_TOKEN ?? "",
    apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl.trim() : DEFAULT_API_BASE_URL,
    rawContentBaseUrl:
      typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
    gittensorApiBase:
      typeof options.gittensorApiBase === "string" && options.gittensorApiBase.trim() ? options.gittensorApiBase.trim() : DEFAULT_GITTENSOR_API_BASE,
    fetchImpl: options.fetchImpl ?? fetch,
    perPage: Number.isInteger(options.perPage) && options.perPage > 0 ? options.perPage : DEFAULT_PER_PAGE,
    maxPages: Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES,
    contributorLogin: typeof options.contributorLogin === "string" ? options.contributorLogin.trim() : "",
    linkedIssues: Array.isArray(options.linkedIssues) ? options.linkedIssues.filter((n) => Number.isInteger(n)) : [],
  };
}

async function githubGetJson(url, resolved) {
  const response = await resolved.fetchImpl(url, { method: "GET", headers: githubHeaders(resolved.githubToken) });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function fetchPaginated(pathWithQuery, resolved) {
  const results = [];
  for (let page = 1; page <= resolved.maxPages; page += 1) {
    const separator = pathWithQuery.includes("?") ? "&" : "?";
    const url = `${resolved.apiBaseUrl}${pathWithQuery}${separator}per_page=${resolved.perPage}&page=${page}`;
    const { response, payload } = await githubGetJson(url, resolved);
    if (!response.ok || !Array.isArray(payload)) break;
    results.push(...payload);
    if (payload.length < resolved.perPage) break;
  }
  return results;
}

// Mirrors src/db/repositories.ts's toRepositoryRecord + upsertRepositoryFromGitHub's field mapping. The
// miner has no App installation/DB, so installationId/isInstalled/isRegistered/registryConfig are honest
// "unregistered" defaults, not values pulled from GitHub -- GitHub's own repo payload carries none of them.
async function fetchRepositoryRecord(target, resolved) {
  const url = `${resolved.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const { response, payload } = await githubGetJson(url, resolved);
  if (!response.ok || !payload || typeof payload !== "object") return null;
  return {
    fullName: `${target.owner}/${target.repo}`,
    owner: payload.owner?.login ?? target.owner,
    name: payload.name ?? target.repo,
    installationId: undefined,
    isInstalled: false,
    isRegistered: false,
    isPrivate: payload.private ?? false,
    htmlUrl: payload.html_url ?? null,
    defaultBranch: payload.default_branch ?? null,
    registryConfig: null,
  };
}

// Mirrors src/db/repositories.ts's extractLinkedPrNumbers exactly.
const LINKED_PR_PATTERN = /\b(?:PR|pull request)\s+#(\d+)\b/gi;
function extractLinkedPrNumbers(body) {
  const numbers = [];
  for (const match of body.matchAll(LINKED_PR_PATTERN)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) numbers.push(number);
  }
  return numbers;
}

// Mirrors src/db/repositories.ts's extractLinkedIssueNumbers: GitHub's own closing-keyword vocabulary, only
// counting a fully-qualified owner/repo#N reference when it targets the SAME repo being fetched.
const LINKED_ISSUE_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+)#|#)(\d+)\b/gi;
function extractLinkedIssueNumbers(body, repoFullName) {
  // Strip backtick code spans first so a closing-keyword pattern quoted as example code doesn't count.
  const withoutCodeSpans = body.replace(/`[^`]*`/g, "");
  const numbers = [];
  const normalizedRepo = repoFullName.toLowerCase();
  for (const match of withoutCodeSpans.matchAll(LINKED_ISSUE_PATTERN)) {
    const qualifiedRepo = match[1];
    if (qualifiedRepo !== undefined && qualifiedRepo.toLowerCase() !== normalizedRepo) continue;
    const number = Number(match[2]);
    if (Number.isInteger(number) && number > 0) numbers.push(number);
  }
  return numbers;
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => (label && typeof label === "object" && typeof label.name === "string" ? [label.name] : []));
}

// Mirrors src/db/repositories.ts's toIssueRecord, populated straight from the live payload (createdAt/
// updatedAt/closedAt come from the DB-row read path there only as a caching artifact, not a semantic
// transform -- the live REST fields are the real source).
function toIssueRecord(repoFullName, issue) {
  const body = issue.body ?? "";
  return {
    repoFullName,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    authorLogin: issue.user?.login ?? null,
    authorAssociation: issue.author_association ?? null,
    htmlUrl: issue.html_url ?? null,
    body,
    createdAt: issue.created_at ?? null,
    updatedAt: issue.updated_at ?? null,
    closedAt: issue.closed_at ?? null,
    labels: labelNames(issue.labels),
    linkedPrs: extractLinkedPrNumbers(body),
  };
}

async function fetchOpenIssueRecords(target, resolved) {
  const payloads = await fetchPaginated(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues?state=open&sort=created&direction=asc`,
    resolved,
  );
  // GitHub's Issues endpoint also returns pull requests -- filter them out, same as the live gate's own fetch.
  return payloads.filter((issue) => issue && typeof issue === "object" && !issue.pull_request).map((issue) => toIssueRecord(`${target.owner}/${target.repo}`, issue));
}

function mergeableBooleanState(mergeable) {
  if (mergeable === true) return "clean";
  if (mergeable === false) return "dirty";
  return null;
}

// Mirrors src/db/repositories.ts's toPullRequestRecord. Only the fields SelfReviewContext/buildCollisionReport
// actually consume are populated with real precision; merge/RC3 gate-plumbing fields the live gate's fuller
// PullRequestRecord carries (mergeAttemptCount, approvedHeadSha, ...) don't exist on the engine package's
// leaner mirror type and aren't meaningful for a miner attempt anyway.
function toPullRequestRecord(repoFullName, pr) {
  const body = pr.body ?? "";
  return {
    repoFullName,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    authorLogin: pr.user?.login ?? null,
    authorAssociation: pr.author_association ?? null,
    headSha: pr.head?.sha ?? null,
    headRef: pr.head?.ref ?? null,
    baseRef: pr.base?.ref ?? null,
    htmlUrl: pr.html_url ?? null,
    mergedAt: pr.merged_at ?? null,
    isDraft: pr.draft ?? null,
    mergeableState: pr.mergeable_state ?? mergeableBooleanState(pr.mergeable),
    reviewDecision: null,
    body,
    createdAt: pr.created_at ?? null,
    updatedAt: pr.updated_at ?? null,
    closedAt: pr.closed_at ?? null,
    labels: labelNames(pr.labels),
    linkedIssues: extractLinkedIssueNumbers(body, repoFullName),
  };
}

async function fetchOpenPullRequestRecords(target, resolved) {
  const payloads = await fetchPaginated(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls?state=open&sort=created&direction=asc`,
    resolved,
  );
  return payloads.map((pr) => toPullRequestRecord(`${target.owner}/${target.repo}`, pr));
}

// Mirrors src/signals/focus-manifest-loader.ts's raw-content lookup order and bounded body read:
// first candidate path that resolves wins, but hostile manifests never exceed the parser byte cap in memory.
async function readBoundedManifestResponseText(response) {
  const contentLength = response.headers?.get?.("content-length") ?? null;
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_FOCUS_MANIFEST_BYTES) return null;
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (typeof text !== "string") return null;
    return new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES ? null : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_FOCUS_MANIFEST_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchManifestContent(target, resolved) {
  for (const path of MANIFEST_FILE_CANDIDATES) {
    const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
    try {
      const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "gittensory-miner" } });
      if (response.ok) {
        const text = await readBoundedManifestResponseText(response);
        if (typeof text === "string") return text;
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

// Mirrors src/gittensor/api.ts's fetchGittensorContributorSnapshot/fetchOfficialGittensorMiner: a public,
// unauthenticated GET against the Gittensor API (not GitHub) -- confirmed only when a real entry with a
// matching GitHub login is found; any transport/parse failure fails closed to "not confirmed", never throws.
async function fetchConfirmedContributor(login, resolved) {
  if (!login) return false;
  try {
    const response = await resolved.fetchImpl(`${resolved.gittensorApiBase}/miners`, { method: "GET", headers: { accept: "application/json" } });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload)) return false;
    const normalizedLogin = login.toLowerCase();
    return payload.some((miner) => typeof miner?.githubUsername === "string" && miner.githubUsername.toLowerCase() === normalizedLogin);
  } catch {
    return false;
  }
}

// Per self-review-adapter.ts's own doc comment: the caller computes inDuplicateCluster "the same way the
// live gate's collision report would" -- adapted from src/signals/engine.ts's real
// isPullRequestInDuplicateCluster (root src/, not extracted to the engine package), which requires >= 2
// PULL REQUEST items in a high-risk cluster, not just any high-risk cluster containing the target. That
// threshold matters: buildCollisionReport's own pairwise "shared linked issue" rule already marks an
// issue+its-one-legitimately-closing-PR pair as a HIGH-risk cluster (confirmed empirically) -- without the
// >= 2 threshold, inDuplicateCluster would fire on the completely normal case of "one PR already closes
// this issue," not genuine overlapping/duplicate work. Checks the target ISSUE's presence instead of a
// not-yet-existing PR number, since the miner's own submission doesn't exist as a real PullRequestRecord yet.
function computeInDuplicateCluster(repoFullName, issues, pullRequests, targetIssueNumbers) {
  if (targetIssueNumbers.length === 0) return false;
  const report = buildCollisionReport(repoFullName, issues, pullRequests);
  return report.clusters.some(
    (cluster) =>
      cluster.risk === "high" &&
      cluster.items.filter((item) => item.type === "pull_request").length >= 2 &&
      cluster.items.some((item) => item.type === "issue" && targetIssueNumbers.includes(item.number)),
  );
}

/**
 * Build a real SelfReviewContext from live GitHub data, at the same fidelity the live gate's own DB-backed
 * construction produces. See this file's header for the two fields (bounties, issueQuality) deliberately
 * left undefined and why.
 *
 * @param {string} repoFullName
 * @param {{
 *   githubToken?: string, contributorLogin?: string, linkedIssues?: number[],
 *   apiBaseUrl?: string, rawContentBaseUrl?: string, gittensorApiBase?: string,
 *   fetchImpl?: typeof fetch, perPage?: number, maxPages?: number,
 * }} [options]
 * @returns {Promise<import("./self-review-context.js").SelfReviewContextResult>}
 */
export async function fetchSelfReviewContext(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) throw new Error("invalid_repo_full_name");
  const resolved = normalizeOptions(options);

  const [repo, issues, pullRequests, manifestContent, confirmedContributor] = await Promise.all([
    fetchRepositoryRecord(target, resolved),
    fetchOpenIssueRecords(target, resolved),
    fetchOpenPullRequestRecords(target, resolved),
    fetchManifestContent(target, resolved),
    fetchConfirmedContributor(resolved.contributorLogin, resolved),
  ]);

  const manifest = parseFocusManifestContent(manifestContent, "repo_file");
  const inDuplicateCluster = computeInDuplicateCluster(`${target.owner}/${target.repo}`, issues, pullRequests, resolved.linkedIssues);

  return {
    manifest,
    repo,
    issues,
    pullRequests,
    confirmedContributor,
    inDuplicateCluster,
  };
}
