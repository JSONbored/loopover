import {
  buildCollisionReport,
  buildIssueQualityReport,
  MAX_FOCUS_MANIFEST_BYTES,
  parseFocusManifestContent,
} from "@loopover/engine";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";

// Real SelfReviewContext fetcher (#5145, Wave 3.5). Builds the context object the miner's self-review pass
// (packages/loopover-engine/src/miner/self-review-adapter.ts) needs, at the SAME fidelity the live gate's
// own DB-backed construction produces (src/db/repositories.ts's toRepositoryRecord/toIssueRecord/
// toPullRequestRecord) -- just built fresh from live GitHub data instead of a DB round-trip, since the miner
// has no database. One of SelfReviewContext's eight fields is DELIBERATELY left undefined, not stubbed:
//
//   - `bounties`: bounty data is not GitHub-native in this codebase -- it comes from an external "Gitt"
//     system that PUSHES data into the live gate's own internal ingest route (src/api/routes.ts). There is
//     no public endpoint the miner could legitimately pull from instead.
//
// `issueQuality` is populated via buildIssueQualityReport (exported from @loopover/engine as a package-local
// twin of the host engine helper — see #6057). Bounty rows and recent-merged PR history are passed as empty
// arrays because this fetcher does not yet pull either source. `bounties` remains omitted for the reason above.
//
// #6487: after the static `.loopover.yml` reconstruction, optionally probe ORB's live-gate-thresholds endpoint
// (same loopover-mcp session posture as resolveGitHubToken). On success, overlay confidence_floor /
// scope_cap_files / scope_cap_lines onto the parsed manifest gate; on 403/timeout/404/no-session, keep the
// static reconstruction unchanged. Fully-standalone (ORB-absent) paths stay byte-identical.

const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const DEFAULT_GITTENSOR_API_BASE = "https://api.gittensor.io";
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
/** Short ORB probe budget (#6487) — must never make discover/gate-prediction meaningfully slower when ORB is absent. */
const DEFAULT_LIVE_GATE_PROBE_TIMEOUT_MS = 400;

// Mirrors src/signals/focus-manifest-loader.ts's MANIFEST_FILE_CANDIDATES exactly -- first candidate that
// resolves wins, same as the live gate's own lookup order.
const MANIFEST_FILE_CANDIDATES = [".loopover.yml", ".github/loopover.yml", ".loopover.json", ".github/loopover.json"];

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

function githubHeaders(githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "loopover-miner",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function normalizeOptions(options = {}) {
  const env = options.env ?? process.env;
  // Explicit null skips the probe (tests / forced-standalone). Undefined ⇒ resolve from loopover-mcp session.
  const loopoverAuth =
    options.loopoverAuth === null
      ? null
      : options.loopoverAuth && typeof options.loopoverAuth.sessionToken === "string" && options.loopoverAuth.sessionToken
        ? {
            apiUrl:
              typeof options.loopoverAuth.apiUrl === "string" && options.loopoverAuth.apiUrl.trim()
                ? options.loopoverAuth.apiUrl.replace(/\/+$/, "")
                : (resolveLoopoverBackendSession(env)?.apiUrl ?? "https://api.loopover.ai"),
            sessionToken: options.loopoverAuth.sessionToken,
          }
        : resolveLoopoverBackendSession(env);
  return {
    githubToken: options.githubToken ?? env.GITHUB_TOKEN ?? "",
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
    requestTimeoutMs: Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
    liveGateProbeTimeoutMs:
      Number.isInteger(options.liveGateProbeTimeoutMs) && options.liveGateProbeTimeoutMs > 0
        ? options.liveGateProbeTimeoutMs
        : DEFAULT_LIVE_GATE_PROBE_TIMEOUT_MS,
    loopoverAuth,
  };
}

/** Validate the field-limited #6486/#6487 payload; null when nothing usable is present. */
export function parseLiveGateThresholdFields(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const confidence_floor =
    typeof payload.confidence_floor === "number" && payload.confidence_floor >= 0 && payload.confidence_floor <= 1
      ? payload.confidence_floor
      : null;
  const scope_cap_files = typeof payload.scope_cap_files === "number" && payload.scope_cap_files > 0 ? payload.scope_cap_files : null;
  const scope_cap_lines = typeof payload.scope_cap_lines === "number" && payload.scope_cap_lines > 0 ? payload.scope_cap_lines : null;
  if (confidence_floor === null && scope_cap_files === null && scope_cap_lines === null) return null;
  return { confidence_floor, scope_cap_files, scope_cap_lines };
}

/**
 * Overlay live ORB thresholds onto a statically-reconstructed FocusManifest (#6487).
 * - confidence_floor → raise-only readinessMinScore (mirrors applySelfTuneOverrideToSettings).
 * - scope_cap_files / scope_cap_lines → prefer live sizeMaxFiles / sizeMaxLines when present.
 * Other gate fields are left untouched.
 */
export function applyLiveGateThresholdsToManifest(manifest, fields) {
  if (!manifest || !fields) return manifest;
  const gate = { ...manifest.gate };
  if (typeof fields.confidence_floor === "number") {
    const floorScore = Math.max(0, Math.min(100, Math.round(fields.confidence_floor * 100)));
    if (typeof gate.readinessMinScore === "number" && floorScore > gate.readinessMinScore) {
      gate.readinessMinScore = floorScore;
    }
  }
  if (typeof fields.scope_cap_files === "number" && fields.scope_cap_files > 0) {
    gate.sizeMaxFiles = fields.scope_cap_files;
  }
  if (typeof fields.scope_cap_lines === "number" && fields.scope_cap_lines > 0) {
    gate.sizeMaxLines = fields.scope_cap_lines;
  }
  return { ...manifest, gate };
}

async function probeLiveGateThresholds(target, resolved) {
  const auth = resolved.loopoverAuth;
  if (!auth?.sessionToken) return null;
  const url = `${auth.apiUrl}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/live-gate-thresholds`;
  try {
    const response = await fetchWithTimeout(
      resolved.fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${auth.sessionToken}`,
          accept: "application/json",
          "user-agent": "loopover-miner",
        },
      },
      resolved.liveGateProbeTimeoutMs,
    );
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return parseLiveGateThresholdFields(payload);
  } catch {
    return null;
  }
}

// A fresh AbortSignal.timeout() per call, so a stalled connection can't hang context construction forever
// (#miner-github-read-timeouts) -- shared by this file's three independent fetch call sites (GitHub REST, raw
// manifest content, the Gittensor contributor lookup).
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function githubGetJson(url, resolved) {
  const response = await fetchWithTimeout(resolved.fetchImpl, url, { method: "GET", headers: githubHeaders(resolved.githubToken) }, resolved.requestTimeoutMs);
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
      const response = await fetchWithTimeout(resolved.fetchImpl, url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } }, resolved.requestTimeoutMs);
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
    const response = await fetchWithTimeout(resolved.fetchImpl, `${resolved.gittensorApiBase}/miners`, { method: "GET", headers: { accept: "application/json" } }, resolved.requestTimeoutMs);
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
// Takes a prebuilt CollisionReport so issueQuality and inDuplicateCluster share one collision pass.
function computeInDuplicateCluster(collisionReport, targetIssueNumbers) {
  if (targetIssueNumbers.length === 0) return false;
  return collisionReport.clusters.some(
    (cluster) =>
      cluster.risk === "high" &&
      cluster.items.filter((item) => item.type === "pull_request").length >= 2 &&
      cluster.items.some((item) => item.type === "issue" && targetIssueNumbers.includes(item.number)),
  );
}

/**
 * Build a real SelfReviewContext from live GitHub data, at the same fidelity the live gate's own DB-backed
 * construction produces. See this file's header for the one field (bounties) deliberately left undefined
 * and why; issueQuality is populated from the live GitHub snapshot. Optionally overlays ORB live gate
 * thresholds onto the static `.loopover.yml` reconstruction (#6487).
 *
 * @param {string} repoFullName
 * @param {{
 *   githubToken?: string, contributorLogin?: string, linkedIssues?: number[],
 *   apiBaseUrl?: string, rawContentBaseUrl?: string, gittensorApiBase?: string,
 *   fetchImpl?: typeof fetch, perPage?: number, maxPages?: number, requestTimeoutMs?: number,
 *   liveGateProbeTimeoutMs?: number,
 *   loopoverAuth?: { apiUrl?: string, sessionToken: string } | null,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 * @returns {Promise<import("./self-review-context.js").SelfReviewContextResult>}
 */
export async function fetchSelfReviewContext(repoFullName, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target) throw new Error("invalid_repo_full_name");
  const resolved = normalizeOptions(options);

  const [repo, issues, pullRequests, manifestContent, confirmedContributor, liveGateThresholds] = await Promise.all([
    fetchRepositoryRecord(target, resolved),
    fetchOpenIssueRecords(target, resolved),
    fetchOpenPullRequestRecords(target, resolved),
    fetchManifestContent(target, resolved),
    fetchConfirmedContributor(resolved.contributorLogin, resolved),
    probeLiveGateThresholds(target, resolved),
  ]);

  const staticManifest = parseFocusManifestContent(manifestContent, "repo_file");
  const manifest = applyLiveGateThresholdsToManifest(staticManifest, liveGateThresholds);
  // Positional args match buildIssueQualityReport(repo, issues, pullRequests, fullName, bounties, collisions, recentMerged):
  // repo is the full RepositoryRecord from fetchRepositoryRecord (not a string); empty bounties/recentMerged
  // because this fetcher has no external bounty source and does not yet pull merge history.
  const fullName = `${target.owner}/${target.repo}`;
  const collisions = buildCollisionReport(fullName, issues, pullRequests);
  const inDuplicateCluster = computeInDuplicateCluster(collisions, resolved.linkedIssues);
  const issueQuality = buildIssueQualityReport(repo, issues, pullRequests, fullName, [], collisions, []);

  return {
    manifest,
    repo,
    issues,
    pullRequests,
    confirmedContributor,
    inDuplicateCluster,
    issueQuality,
  };
}
