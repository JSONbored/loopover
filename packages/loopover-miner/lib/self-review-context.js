import { buildCollisionReport, buildIssueQualityReport, MAX_FOCUS_MANIFEST_BYTES, parseFocusManifestContent, } from "@loopover/engine";
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";
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
// `githubToken` is always a real string here: this function is private and its sole caller (githubGetJson,
// via resolved.githubToken) already comes from normalizeOptions' own `options.githubToken ?? env.GITHUB_TOKEN
// ?? ""` fallback chain, which always resolves to a string.
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": GITHUB_API_VERSION,
    };
    if (githubToken)
        headers.authorization = `Bearer ${githubToken}`;
    return headers;
}
// resolveLoopoverBackendSession types `env` as the ambient (Cloudflare-Workers-augmented) `NodeJS.ProcessEnv`,
// stricter than this file's own `Record<string, string | undefined>` -- github-token-resolution.js isn't
// converted to TypeScript yet, and any object matching this shape genuinely satisfies it at runtime either way.
const resolveBackendSession = resolveLoopoverBackendSession;
function normalizeOptions(options = {}) {
    const env = options.env ?? process.env;
    // Explicit null skips the probe (tests / forced-standalone). Undefined ⇒ resolve from loopover-mcp session.
    const loopoverAuth = options.loopoverAuth === null
        ? null
        : options.loopoverAuth && typeof options.loopoverAuth.sessionToken === "string" && options.loopoverAuth.sessionToken
            ? {
                apiUrl: typeof options.loopoverAuth.apiUrl === "string" && options.loopoverAuth.apiUrl.trim()
                    ? options.loopoverAuth.apiUrl.replace(/\/+$/, "")
                    : (resolveBackendSession(env)?.apiUrl ?? "https://api.loopover.ai"),
                sessionToken: options.loopoverAuth.sessionToken,
            }
            : resolveBackendSession(env);
    return {
        githubToken: options.githubToken ?? env.GITHUB_TOKEN ?? "",
        apiBaseUrl: typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim() ? options.apiBaseUrl.trim() : DEFAULT_API_BASE_URL,
        rawContentBaseUrl: typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
        gittensorApiBase: typeof options.gittensorApiBase === "string" && options.gittensorApiBase.trim() ? options.gittensorApiBase.trim() : DEFAULT_GITTENSOR_API_BASE,
        fetchImpl: options.fetchImpl ?? fetch,
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
async function fetchPaginated(pathWithQuery, resolved) {
    const results = [];
    for (let page = 1; page <= resolved.maxPages; page += 1) {
        const separator = pathWithQuery.includes("?") ? "&" : "?";
        const url = `${resolved.apiBaseUrl}${pathWithQuery}${separator}per_page=${resolved.perPage}&page=${page}`;
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
    const record = payload;
    return {
        fullName: `${target.owner}/${target.repo}`,
        owner: record.owner?.login ?? target.owner,
        name: record.name ?? target.repo,
        installationId: undefined,
        isInstalled: false,
        isRegistered: false,
        isPrivate: record.private ?? false,
        htmlUrl: record.html_url ?? null,
        defaultBranch: record.default_branch ?? null,
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
    const user = issue.user;
    return {
        repoFullName,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        authorLogin: user?.login ?? null,
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
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues?state=open&sort=created&direction=asc`, resolved);
    // GitHub's Issues endpoint also returns pull requests -- filter them out, same as the live gate's own fetch.
    return payloads
        .filter((issue) => Boolean(issue) && typeof issue === "object" && !issue.pull_request)
        .map((issue) => toIssueRecord(`${target.owner}/${target.repo}`, issue));
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
    const user = pr.user;
    const head = pr.head;
    const base = pr.base;
    return {
        repoFullName,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        authorLogin: user?.login ?? null,
        authorAssociation: pr.author_association ?? null,
        headSha: head?.sha ?? null,
        headRef: head?.ref ?? null,
        baseRef: base?.ref ?? null,
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
    const payloads = await fetchPaginated(`/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls?state=open&sort=created&direction=asc`, resolved);
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
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            totalBytes += value?.byteLength ?? 0;
            if (totalBytes > MAX_FOCUS_MANIFEST_BYTES) {
                await reader.cancel();
                return null;
            }
            if (value)
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2VsZi1yZXZpZXctY29udGV4dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNlbGYtcmV2aWV3LWNvbnRleHQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUNMLG9CQUFvQixFQUNwQix1QkFBdUIsRUFDdkIsd0JBQXdCLEVBQ3hCLHlCQUF5QixHQUMxQixNQUFNLGtCQUFrQixDQUFDO0FBRTFCLE9BQU8sRUFBRSw2QkFBNkIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBeUY3RSxNQUFNLGtCQUFrQixHQUFHLFlBQVksQ0FBQztBQUN4QyxNQUFNLG9CQUFvQixHQUFHLHdCQUF3QixDQUFDO0FBQ3RELE1BQU0sNEJBQTRCLEdBQUcsbUNBQW1DLENBQUM7QUFDekUsTUFBTSwwQkFBMEIsR0FBRywwQkFBMEIsQ0FBQztBQUM5RCxNQUFNLGdCQUFnQixHQUFHLEdBQUcsQ0FBQztBQUM3QixNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQztBQUM3QixNQUFNLDBCQUEwQixHQUFHLE1BQU0sQ0FBQztBQUMxQyx3SEFBd0g7QUFDeEgsTUFBTSxrQ0FBa0MsR0FBRyxHQUFHLENBQUM7QUFFL0MsMEdBQTBHO0FBQzFHLDJEQUEyRDtBQUMzRCxNQUFNLHdCQUF3QixHQUFHLENBQUMsZUFBZSxFQUFFLHNCQUFzQixFQUFFLGdCQUFnQixFQUFFLHVCQUF1QixDQUFDLENBQUM7QUFFdEgsU0FBUyxpQkFBaUIsQ0FBQyxZQUFvQjtJQUM3QyxJQUFJLE9BQU8sWUFBWSxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNsRCxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN4RCxPQUFPLEVBQUUsS0FB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