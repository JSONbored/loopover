import { CONTRIBUTION_PROFILE_SCHEMA_VERSION, emptyContributionProfile, weakestConfidence, } from "./contribution-profile.js";
import { fetchWithRetry } from "./http-retry.js";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;
/** A CONTRIBUTING.md smaller than this is treated as a signpost (a link to an external guide), not the rules
 *  themselves — #6794 found react's is 208 B and laravel' 525 B, both just pointers. */
const CONTRIBUTING_SIGNPOST_MAX_BYTES = 600;
/** Canonical eligibility vocabulary — recognized OSS "contributor-workable" conventions. Matched case-insensitively
 *  as a substring over a label's name AND description. Not loopover-specific. */
const ELIGIBILITY_TERMS = Object.freeze([
    "good first issue",
    "good-first-issue",
    "help wanted",
    "help-wanted",
    "up for grabs",
    "beginner",
    "easy",
    "starter",
]);
/** Conventional exclusion/off-limits vocabulary. These are UNstated conventions (#6794 found no repo names
 *  exclusion in a label NAME explicitly), so a match yields `inferred`, never `explicit`. */
const EXCLUSION_TERMS = Object.freeze([
    "blocked",
    "on hold",
    "on-hold",
    "do not merge",
    "wontfix",
    "invalid",
    "needs triage",
    "work in progress",
    "wip",
    "maintainer only",
    "internal",
]);
/** Closing-keyword / linked-issue language in a CONTRIBUTING.md. */
const LINKED_ISSUE_TERMS = Object.freeze([
    "closes #",
    "fixes #",
    "resolves #",
    "linked issue",
    "reference an issue",
    "link to an issue",
]);
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner?.trim() || !repo?.trim() || extra !== undefined)
        return null;
    return { owner: owner.trim(), repo: repo.trim() };
}
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
/** Bounded, never-throwing JSON GET. Rides out a transient GitHub 5xx or rate-limit response (429 / secondary-403)
 *  via `fetchWithRetry` — the same discipline opportunity-fanout.js's sibling `githubGetJson` already uses — before
 *  falling back to its fail-open contract: returns null on a non-retryable/exhausted HTTP, transport, or parse
 *  failure. `timeoutMs` gives each attempt its own fresh `AbortSignal.timeout` (preserving the per-request bound),
 *  and `sleepFn` is the injectable no-real-timers seam every other `fetchWithRetry` call site exposes. */
async function getJson(url, headers, fetchImpl, sleepFn) {
    let response;
    try {
        // Cast: the JS always passes `sleepFn` (possibly undefined); EOPT rejects an explicit undefined optional.
        response = await fetchWithRetry(fetchImpl, url, { method: "GET", headers }, { sleepFn, timeoutMs: REQUEST_TIMEOUT_MS });
    }
    catch {
        return null;
    }
    if (!response.ok)
        return null;
    return response.json().catch(() => null);
}
/**
 * Match one label against a term list, preferring the NAME but falling back to the DESCRIPTION (the rust
 * `E-easy` finding: a label can carry its eligibility meaning only in the description). Returns the matcher +
 * a provenance detail, or null when neither field matches.
 */
function matchLabel(label, terms) {
    const rawName = typeof label?.name === "string" ? label.name : "";
    const name = rawName.toLowerCase();
    const description = typeof label?.description === "string"
        ? label.description.toLowerCase()
        : "";
    const detail = rawName || "(unnamed label)";
    const nameTerm = terms.find((term) => name.includes(term));
    if (nameTerm !== undefined)
        return { matcher: { field: "name", contains: nameTerm }, detail };
    const descriptionTerm = terms.find((term) => description.includes(term));
    if (descriptionTerm !== undefined)
        return {
            matcher: { field: "description", contains: descriptionTerm },
            detail,
        };
    return null;
}
/** Classify labels into a SignalRule of the given confidence. Recognized labels build an OR-list of matchers;
 *  no match ⇒ `absent`. Eligibility passes `explicit` (a recognized convention IS an explicit statement);
 *  exclusion passes `inferred` (conventional but unstated). */
function classifyLabels(labels, terms, matchedConfidence) {
    const matchers = [];
    const provenance = [];
    for (const label of labels) {
        const hit = matchLabel(label, terms);
        if (hit === null)
            continue;
        matchers.push(hit.matcher);
        provenance.push({ source: "labels", detail: hit.detail });
    }
    if (matchers.length === 0)
        return { value: null, confidence: "absent", provenance: [] };
    return { value: matchers, confidence: matchedConfidence, provenance };
}
/** Decode a GitHub contents API response body to text. Returns null when absent or not base64. Buffer.from over
 *  a string never throws, so no error path is needed here. */
function decodeContents(payload) {
    if (!payload ||
        typeof payload !== "object" ||
        typeof payload.content !== "string" ||
        payload.encoding !== "base64")
        return null;
    return Buffer.from(payload.content, "base64").toString("utf8");
}
/** Fetch CONTRIBUTING.md, probing the repo root then `.github/` (#6794: 6/10 at root, 2/10 under `.github/`). */
async function fetchContributing(base, target, headers, fetchImpl, sleepFn) {
    for (const path of ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"]) {
        const payload = await getJson(`${base}/repos/${target.owner}/${target.repo}/contents/${path}`, headers, fetchImpl, sleepFn);
        const text = decodeContents(payload);
        if (text !== null)
            return text;
    }
    return null;
}
/** Extract the PR-body linked-issue requirement from CONTRIBUTING.md. A very small file is a signpost, not the
 *  rules, so it yields `absent` rather than a false negative dressed as a real one. */
function extractPrBody(contributing) {
    if (contributing === null)
        return { value: null, confidence: "absent", provenance: [] };
    if (contributing.length < CONTRIBUTING_SIGNPOST_MAX_BYTES)
        return { value: null, confidence: "unknown", provenance: [] };
    const lower = contributing.toLowerCase();
    const requiresLinkedIssue = LINKED_ISSUE_TERMS.some((term) => lower.includes(term));
    // A real, sufficiently-sized CONTRIBUTING.md is an explicit source either way: present-with-keyword is an
    // explicit requirement, present-without is an explicit "no such rule".
    return {
        value: { requiresLinkedIssue },
        confidence: "explicit",
        provenance: [{ source: "contributing_md", detail: "CONTRIBUTING.md" }],
    };
}
/**
 * Extract a best-effort ContributionProfile for a repo from what it actually publishes.
 */
export async function extractContributionProfile(repoFullName, options = {}) {
    const generatedAt = typeof options.generatedAt === "string"
        ? options.generatedAt
        : new Date().toISOString();
    const target = parseRepoFullName(repoFullName);
    // A malformed name can't be fetched — return the safe, fully-absent default rather than throwing.
    if (target === null)
        return emptyContributionProfile(typeof repoFullName === "string" ? repoFullName : "", generatedAt);
    /* v8 ignore next -- the global-fetch default is the production path; every test injects fetchImpl. */
    const fetchImpl = options.fetchImpl ?? fetch;
    const base = typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim()
        ? options.apiBaseUrl.replace(/\/+$/, "")
        : DEFAULT_API_BASE_URL;
    const headers = githubHeaders(options.githubToken ?? process.env.GITHUB_TOKEN);
    const sleepFn = options.sleepFn;
    const labelsPayload = await getJson(`${base}/repos/${target.owner}/${target.repo}/labels?per_page=100`, headers, fetchImpl, sleepFn);
    const labels = Array.isArray(labelsPayload) ? labelsPayload : [];
    const contributing = await fetchContributing(base, target, headers, fetchImpl, sleepFn);
    const eligibilityLabels = classifyLabels(labels, ELIGIBILITY_TERMS, "explicit");
    const exclusionLabels = classifyLabels(labels, EXCLUSION_TERMS, "inferred");
    const prBody = extractPrBody(contributing);
    return {
        repoFullName: `${target.owner}/${target.repo}`,
        schemaVersion: CONTRIBUTION_PROFILE_SCHEMA_VERSION,
        generatedAt,
        eligibilityLabels,
        exclusionLabels,
        prBody,
        completeness: weakestConfidence([
            eligibilityLabels.confidence,
            exclusionLabels.confidence,
            prBody.confidence,
        ]),
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtZXh0cmFjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvbnRyaWJ1dGlvbi1wcm9maWxlLWV4dHJhY3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBY0EsT0FBTyxFQUNMLG1DQUFtQyxFQUNuQyx3QkFBd0IsRUFDeEIsaUJBQWlCLEdBQ2xCLE1BQU0sMkJBQTJCLENBQUM7QUFDbkMsT0FBTyxFQUFFLGNBQWMsRUFBOEIsTUFBTSxpQkFBaUIsQ0FBQztBQUU3RSxNQUFNLG9CQUFvQixHQUFHLHdCQUF3QixDQUFDO0FBQ3RELE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBQ3hDLE1BQU0sa0JBQWtCLEdBQUcsTUFBTSxDQUFDO0FBQ2xDO3dGQUN3RjtBQUN4RixNQUFNLCtCQUErQixHQUFHLEdBQUcsQ0FBQztBQUU1QztpRkFDaUY7QUFDakYsTUFBTSxpQkFBaUIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ3RDLGtCQUFrQjtJQUNsQixrQkFBa0I7SUFDbEIsYUFBYTtJQUNiLGFBQWE7SUFDYixjQUFjO0lBQ2QsVUFBVTtJQUNWLE1BQU07SUFDTixTQUFTO0NBQ1YsQ0FBQyxDQUFDO0FBRUg7NkZBQzZGO0FBQzdGLE1BQU0sZUFBZSxHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDcEMsU0FBUztJQUNULFNBQVM7SUFDVCxTQUFTO0lBQ1QsY0FBYztJQUNkLFNBQVM7SUFDVCxTQUFTO0lBQ1QsY0FBYztJQUNkLGtCQUFrQjtJQUNsQixLQUFLO0lBQ0wsaUJBQWlCO0lBQ2pCLFVBQVU7Q0FDWCxDQUFDLENBQUM7QUFFSCxvRUFBb0U7QUFDcEUsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDO0lBQ3ZDLFVBQVU7SUFDVixTQUFTO0lBQ1QsWUFBWTtJQUNaLGNBQWM7SUFDZCxvQkFBb0I7SUFDcEIsa0JBQWtCO0NBQ25CLENBQUMsQ0FBQztBQWNILFNBQVMsaUJBQWlCLENB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