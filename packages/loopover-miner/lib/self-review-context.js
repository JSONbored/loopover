import { buildCollisionReport, buildIssueQualityReport, MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent, } from "@loopover/engine";
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
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": GITHUB_API_VERSION,
    };
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function normalizeOptions(options = {}) {
    const env = options.env ?? process.env;
    // Explicit null skips the probe (tests / forced-standalone). Undefined ⇒ resolve from loopover-mcp session.
    const loopoverAuth = options.loopoverAuth === null
        ? null
        : options.loopoverAuth && typeof options.loopoverAuth.sessionToken === "string" && options.loopoverAuth.sessionToken
            ? {
                apiUrl: typeof options.loopoverAuth.apiUrl === "string" && options.loopoverAuth.apiUrl.trim()
                    ? options.loopoverAuth.apiUrl.replace(/\/+$/, "")
                    : (resolveLoopoverBackendSession(env)?.apiUrl ?? "https://api.loopover.ai"),
                sessionToken: options.loopoverAuth.sessionToken,
            }
            : resolveLoopoverBackendSession(env);
    return {
        githubToken: options.githubToken ?? env.GITHUB_TOKEN ?? "",
        apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl.trim() : DEFAULT_API_BASE_URL,
        rawContentBaseUrl: typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
        gittensorApiBase: typeof options.gittensorApiBase === "string" && options.gittensorApiBase.trim() ? options.gittensorApiBase.trim() : DEFAULT_GITTENSOR_API_BASE,
        fetchImpl: (options.fetchImpl ?? fetch),
        perPage: Number.isInteger(options.perPage) && options.perPage > 0 ? options.perPage : DEFAULT_PER_PAGE,
        maxPages: Number.isInteger(options.maxPages) && options.maxPages > 0 ? options.maxPages : DEFAULT_MAX_PAGES,
        contributorLogin: typeof options.contributorLogin === "string" ? options.contributorLogin.trim() : "",
        linkedIssues: Array.isArray(options.linkedIssues) ? options.linkedIssues.filter((n) => Number.isInteger(n)) : [],
        requestTimeoutMs: Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0 ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS,
        liveGateProbeTimeoutMs: Number.isInteger(options.liveGateProbeTimeoutMs) && options.liveGateProbeTimeoutMs > 0
            ? options.liveGateProbeTimeoutMs
            : DEFAULT_LIVE_GATE_PROBE_TIMEOUT_MS,
        loopoverAuth,
    };
}
/** Validate the field-limited #6486/#6487 payload; null when nothing usable is present. */
export function parseLiveGateThresholdFields(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    const confidence_floor = typeof record.confidence_floor === "number" && record.confidence_floor >= 0 && record.confidence_floor <= 1
        ? record.confidence_floor
        : null;
    const scope_cap_files = typeof record.scope_cap_files === "number" && record.scope_cap_files > 0 ? record.scope_cap_files : null;
    const scope_cap_lines = typeof record.scope_cap_lines === "number" && record.scope_cap_lines > 0 ? record.scope_cap_lines : null;
    if (confidence_floor === null && scope_cap_files === null && scope_cap_lines === null)
        return null;
    return { confidence_floor, scope_cap_files, scope_cap_lines };
}
/**
 * Overlay live ORB thresholds onto a statically-reconstructed FocusManifest (#6487).
 * - confidence_floor → raise-only readinessMinScore (mirrors applySelfTuneOverrideToSettings).
 * - scope_cap_files / scope_cap_lines → prefer live sizeMaxFiles / sizeMaxLines when present.
 * Other gate fields are left untouched.
 */
export function applyLiveGateThresholdsToManifest(manifest, fields) {
    if (!manifest || !fields)
        return manifest;
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
    if (!auth?.sessionToken)
        return null;
    const url = `${auth.apiUrl}/v1/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/live-gate-thresholds`;
    try {
        const response = await fetchWithTimeout(resolved.fetchImpl, url, {
            method: "GET",
            headers: {
                authorization: `Bearer ${auth.sessionToken}`,
                accept: "application/json",
                "user-agent": "loopover-miner",
            },
        }, resolved.liveGateProbeTimeoutMs);
        if (!response.ok)
            return null;
        const payload = await response.json().catch(() => null);
        return parseLiveGateThresholdFields(payload);
    }
    catch {
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
async function fetchPaginated(path, query, resolved) {
    const results = [];
    for (let page = 1; page <= resolved.maxPages; page += 1) {
        const params = new URLSearchParams({ ...query, per_page: String(resolved.perPage), page: String(page) });
        const url = `${resolved.apiBaseUrl}${path}?${params}`;
        const { response, payload } = await githubGetJson(url, resolved);
        if (!response.ok || !Array.isArray(payload))
            break;
        results.push(...payload);
        if (payload.length < resolved.perPage)
            break;
    }
    return results;
}
// Mirrors src/db/repositories.ts's toRepositoryRecord + upsertRepositoryFromGitHub's field mapping. The
// miner has no App installation/DB, so installationId/isInstalled/isRegistered/registryConfig are honest
// "unregistered" defaults, not values pulled from GitHub -- GitHub's own repo payload carries none of them.
async function fetchRepositoryRecord(target, resolved) {
    const url = `${resolved.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const { response, payload } = await githubGetJson(url, resolved);
    if (!response.ok || !payload || typeof payload !== "object")
        return null;
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
// Mirrors src/db/repositories.ts's extractLinkedPrNumbers: a real link needs a CLOSING KEYWORD, not a bare
// mention (#6769). Without the keyword prefix, an incidental "similar to what we saw in PR #501" in an issue
// body counted as a linked PR, so the issue-quality report read the issue as "already references a PR" and the
// miner skipped an available issue (the host's own #issue-body-pr-mention-pollution fix, never ported here).
const LINKED_PR_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:PR|pull request)\s+#(\d+)\b/gi;
function extractLinkedPrNumbers(body) {
    const numbers = [];
    for (const match of body.matchAll(LINKED_PR_PATTERN)) {
        const number = Number(match[1]);
        if (Number.isInteger(number) && number > 0)
            numbers.push(number);
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
        if (qualifiedRepo !== undefined && qualifiedRepo.toLowerCase() !== normalizedRepo)
            continue;
        const number = Number(match[2]);
        if (Number.isInteger(number) && number > 0)
            numbers.push(number);
    }
    return numbers;
}
function labelNames(labels) {
    if (!Array.isArray(labels))
        return [];
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
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`, { state: "open", sort: "created", direction: "asc" }, resolved);
    // GitHub's Issues endpoint also returns pull requests -- filter them out, same as the live gate's own fetch.
    return payloads.filter((issue) => issue && typeof issue === "object" && !issue.pull_request).map((issue) => toIssueRecord(`${target.owner}/${target.repo}`, issue));
}
function mergeableBooleanState(mergeable) {
    if (mergeable === true)
        return "clean";
    if (mergeable === false)
        return "dirty";
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
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls`, { state: "open", sort: "created", direction: "asc" }, resolved);
    return payloads.map((pr) => toPullRequestRecord(`${target.owner}/${target.repo}`, pr));
}
// Mirrors src/signals/focus-manifest-loader.ts's raw-content lookup order and bounded body read:
// first candidate path that resolves wins, but hostile manifests never exceed the parser byte cap in memory.
async function readBoundedManifestResponseText(response) {
    const contentLength = response.headers?.get?.("content-length") ?? null;
    if (contentLength !== null) {
        const parsedLength = Number.parseInt(contentLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_FOCUS_MANIFEST_BYTES)
            return null;
    }
    if (!response.body?.getReader) {
        const text = await response.text();
        if (typeof text !== "string")
            return null;
        return new TextEncoder().encode(text).byteLength > MAX_FOCUS_MANIFEST_BYTES ? null : text;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value.byteLength;
            if (totalBytes > MAX_FOCUS_MANIFEST_BYTES) {
                await reader.cancel();
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    }
    finally {
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
                if (typeof text === "string")
                    return text;
            }
        }
        catch {
            // Try the next candidate path.
        }
    }
    return null;
}
// Mirrors src/gittensor/api.ts's fetchGittensorContributorSnapshot/fetchOfficialGittensorMiner: a public,
// unauthenticated GET against the Gittensor API (not GitHub) -- confirmed only when a real entry with a
// matching GitHub login is found; any transport/parse failure fails closed to "not confirmed", never throws.
async function fetchConfirmedContributor(login, resolved) {
    if (!login)
        return false;
    try {
        const response = await fetchWithTimeout(resolved.fetchImpl, `${resolved.gittensorApiBase}/miners`, { method: "GET", headers: { accept: "application/json" } }, resolved.requestTimeoutMs);
        if (!response.ok)
            return false;
        const payload = await response.json().catch(() => null);
        if (!Array.isArray(payload))
            return false;
        const normalizedLogin = login.toLowerCase();
        return payload.some((miner) => typeof miner?.githubUsername === "string" && miner.githubUsername.toLowerCase() === normalizedLogin);
    }
    catch {
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
    if (targetIssueNumbers.length === 0)
        return false;
    return collisionReport.clusters.some((cluster) => cluster.risk === "high" &&
        cluster.items.filter((item) => item.type === "pull_request").length >= 2 &&
        cluster.items.some((item) => item.type === "issue" && targetIssueNumbers.includes(item.number)));
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
    if (!target)
        throw new Error("invalid_repo_full_name");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VsZi1yZXZpZXctY29udGV4dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNlbGYtcmV2aWV3LWNvbnRleHQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUNMLG9CQUFvQixFQUNwQix1QkFBdUIsRUFDdkIsd0JBQXdCLEVBQ3hCLHlCQUF5QixHQUMxQixNQUFNLGtCQUFrQixDQUFDO0FBRTFCLE9BQU8sRUFBRSw2QkFBNkIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBa0Q3RSwyR0FBMkc7QUFDM0csMEdBQTBHO0FBQzFHLGtHQUFrRztBQUNsRyw2R0FBNkc7QUFDN0csd0dBQXdHO0FBQ3hHLEVBQUU7QUFDRix3R0FBd0c7QUFDeEcsMkdBQTJHO0FBQzNHLHlFQUF5RTtBQUN6RSxFQUFFO0FBQ0YsNkdBQTZHO0FBQzdHLDRHQUE0RztBQUM1RyxnSEFBZ0g7QUFDaEgsRUFBRTtBQUNGLCtHQUErRztBQUMvRyxvR0FBb0c7QUFDcEcsMkdBQTJHO0FBQzNHLDRGQUE0RjtBQUU1RixNQUFNLGtCQUFrQixHQUFHLFlBQVksQ0FBQztBQUN4QyxNQUFNLG9CQUFvQixHQUFHLHdCQUF3QixDQUFDO0FBQ3RELE1BQU0sNEJBQTRCLEdBQUcsbUNBQW1DLENBQUM7QUFDekUsTUFBTSwwQkFBMEIsR0FBRywwQkFBMEIsQ0FBQztBQUM5RCxNQUFNLGdCQUFnQixHQUFHLEdBQUcsQ0FBQztBQUM3QixNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztBQUM3QixNQUFNLDBCQUEwQixHQUFHLE1BQU0sQ0FBQztBQUMxQyx3SEFBd0g7QUFDeEgsTUFBTSxrQ0FBa0MsR0FBRyxHQUFHLENBQUM7QUFFL0MsMEdBQTBHO0FBQzFHLDJEQUEyRDtBQUMzRCxNQUFNLHdCQUF3QixHQUFHLENBQUMsZUFBZSxFQUFFLHNCQUFzQixFQUFFLGdCQUFnQixFQUFFLHVCQUF1QixDQUFDLENBQUM7QUFFdEgsU0FBUyxpQkFBaUIsQ0FBQyxZQUFpQjtJQUMxQyxJ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