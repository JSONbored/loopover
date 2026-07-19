import { resolveAiPolicyVerdict } from "@loopover/engine";
import { listRecentOwnSubmissions } from "./governor-state.js";
import { resolveRejection } from "./rejection-state-machine.js";
export const REJECTION_REASON_AI_USAGE_POLICY_BAN = "ai_usage_policy_ban";
export const REJECTION_REASON_OWN_SUBMISSION_REJECTED = "own_submission_rejected";
const DEFAULT_RAW_CONTENT_BASE_URL = "https://raw.githubusercontent.com";
const MAX_POLICY_DOC_BYTES = 128 * 1024;
const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Bound the per-call PR-status fetch fan-out (#5655): a miner with a long submission history on one repo must
// not trigger an unbounded burst of GitHub API calls on every attempt -- only the N most recent are checked.
const DEFAULT_MAX_REJECTION_HISTORY_CHECKS = 10;
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
function normalizeOptions(options) {
    return {
        rawContentBaseUrl: typeof options.rawContentBaseUrl === "string" && options.rawContentBaseUrl.trim() ? options.rawContentBaseUrl.trim() : DEFAULT_RAW_CONTENT_BASE_URL,
        fetchImpl: options.fetchImpl ?? fetch,
    };
}
async function readBoundedPolicyDoc(response) {
    const contentLength = response.headers?.get?.("content-length");
    if (contentLength !== undefined && contentLength !== null) {
        const parsedLength = Number.parseInt(contentLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_POLICY_DOC_BYTES)
            return null;
    }
    if (!response.body?.getReader) {
        const text = await response.text();
        return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_POLICY_DOC_BYTES ? text : null;
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
            if (totalBytes > MAX_POLICY_DOC_BYTES) {
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
        reader.releaseLock?.();
    }
}
async function fetchPolicyDoc(target, path, resolved) {
    const url = `${resolved.rawContentBaseUrl}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/HEAD/${path}`;
    try {
        const response = await resolved.fetchImpl(url, { method: "GET", headers: { accept: "application/json", "user-agent": "loopover-miner" } });
        if (!response.ok)
            return null;
        return await readBoundedPolicyDoc(response);
    }
    catch {
        return null;
    }
}
async function fetchPullRequestPayload(target, prNumber, resolved) {
    const url = `${resolved.githubApiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${prNumber}`;
    const headers = { accept: "application/vnd.github+json", "user-agent": "loopover-miner" };
    if (resolved.githubToken)
        headers.authorization = `Bearer ${resolved.githubToken}`;
    const response = await resolved.fetchImpl(url, { method: "GET", headers });
    if (!response.ok)
        return null;
    return await response.json();
}
/**
 * Resolve the SECOND `rejectionSignaled` trigger (#5655): has a prior submission from THIS miner on THIS exact
 * repo already been closed/rejected? Reads this miner's own recorded submissions on the repo
 * (`listRecentOwnSubmissions`, #5134), fetches each one's live PR state, and runs it through `resolveRejection`
 * (#4278) -- returning `true` if ANY was closed without merge. Bounded (only the most recent
 * `maxRejectionHistoryChecks` submissions with a real PR number are fetched) and fully fail-open: a wholesale
 * failure to read submissions resolves to `false` (never fabricated as a rejection), and any single PR
 * fetch/parse failure is skipped so it never blocks the others. Consumes both upstream modules without modifying
 * either. Every dependency is injectable for testing.
 */
export async function resolveOwnRejectionHistory(repoFullName, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target)
        return false;
    const listSubmissions = options.listSubmissions ?? listRecentOwnSubmissions;
    const resolved = {
        fetchImpl: options.fetchImpl ?? fetch,
        githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : (process.env.GITHUB_TOKEN ?? ""),
        githubApiBaseUrl: typeof options.githubApiBaseUrl === "string" && options.githubApiBaseUrl.trim() ? options.githubApiBaseUrl.trim() : DEFAULT_GITHUB_API_BASE_URL,
        maxChecks: Number.isInteger(options.maxRejectionHistoryChecks) && options.maxRejectionHistoryChecks > 0
            ? options.maxRejectionHistoryChecks
            : DEFAULT_MAX_REJECTION_HISTORY_CHECKS,
    };
    let submissions;
    try {
        submissions = listSubmissions({ repoFullName });
    }
    catch {
        return false; // wholesale failure to read own submissions -- fail open, never fabricate a rejection
    }
    const checkable = (Array.isArray(submissions) ? submissions : [])
        .filter((submission) => submission && Number.isInteger(submission.pullRequestNumber) && submission.pullRequestNumber > 0)
        .slice(0, resolved.maxChecks);
    if (checkable.length === 0)
        return false; // no prior submissions on this repo -- no fetch attempted
    for (const submission of checkable) {
        try {
            const payload = await fetchPullRequestPayload(target, submission.pullRequestNumber, resolved);
            if (!payload)
                continue;
            // No signal (gate/duplicate context isn't available here) -- resolveRejection returns non-null only for a
            // PR that is closed-without-merge, which is exactly the "was it rejected" question this check asks.
            const rejection = resolveRejection(payload, undefined, { repoFullName, prNumber: submission.pullRequestNumber });
            if (rejection)
                return true;
        }
        catch {
            // Individual PR fetch/parse/classify failure -- skip this one, keep checking the rest (fail open).
        }
    }
    return false;
}
/**
 * Resolve whether the target repo has signaled it does not want automated/AI-authored contributions --
 * either trigger documented above. Returns `false` (never throws) on any fetch/parse failure for the policy
 * docs, matching resolveAiPolicyVerdict's own fail-open default for an absent/unreadable policy doc. When a
 * trigger fires, returns a trigger-specific reason string so callers can label audit-trail events accurately.
 */
export async function resolveRejectionSignaled(repoFullName, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target)
        return false;
    const resolved = normalizeOptions(options);
    const aiUsage = await fetchPolicyDoc(target, "AI-USAGE.md", resolved);
    const contributing = aiUsage && aiUsage.trim() ? null : await fetchPolicyDoc(target, "CONTRIBUTING.md", resolved);
    const verdict = resolveAiPolicyVerdict({ aiUsage, contributing });
    // First trigger: an explicit live AI-usage-policy ban. A ban short-circuits -- no need to also check history.
    if (!verdict.allowed)
        return REJECTION_REASON_AI_USAGE_POLICY_BAN;
    // Second trigger (#5655): a prior submission from this same miner on this exact repo was closed/rejected.
    const ownHistoryRejected = await resolveOwnRejectionHistory(repoFullName, options);
    return ownHistoryRejected ? REJECTION_REASON_OWN_SUBMISSION_REJECTED : false;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVqZWN0aW9uLXNpZ25hbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInJlamVjdGlvbi1zaWduYWwudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLHNCQUFzQixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDMUQsT0FBTyxFQUFFLHdCQUF3QixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDL0QsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sOEJBQThCLENBQUM7QUFvQmhFLE1BQU0sQ0FBQyxNQUFNLG9DQUFvQyxHQUFHLHFCQUFxQixDQUFDO0FBQzFFLE1BQU0sQ0FBQyxNQUFNLHdDQUF3QyxHQUFHLHlCQUF5QixDQUFDO0FBRWxGLE1BQU0sNEJBQTRCLEdBQUcsbUNBQW1DLENBQUM7QUFDekUsTUFBTSxvQkFBb0IsR0FBRyxHQUFHLEdBQUcsSUFBSSxDQUFDO0FBQ3hDLE1BQU0sMkJBQTJCLEdBQUcsd0JBQXdCLENBQUM7QUFDN0QsOEdBQThHO0FBQzlHLDZHQUE2RztBQUM3RyxNQUFNLG9DQUFvQyxHQUFHLEVBQUUsQ0FBQztBQXFDaEQsU0FBUyxpQkFBaUIsQ0FBQyxZQUFvQjtJQUM3QyxJQUFJLE9BQU8sWUFBWSxLQUFLLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUNsRCxNQUFNLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLENBQUMsR0FBRyxZQUFZLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBQ3JELElBQUksQ0FBQyxLQUFLLElBQUksQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN4RCxPQUFPLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxDQUFDO0FBQ3pCLENBQUM7QUFFRCxTQUFTLGdCQUFnQixDQUFDLE9BQWlDO0lBQ3pELE9BQU87UUFDTCxpQkFBaUIsRUFDZixPQUFPLE9BQU8sQ0FBQyxpQkFBaUIsS0FBSyxRQUFRLElBQUks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