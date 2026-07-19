// ContributionProfile extraction (#6796). Reads a repo's real, published signals — label taxonomy + contribution
// docs — and produces a populated ContributionProfile per the #6795 schema. GENERIC by design: it recognizes
// conventional OSS eligibility/exclusion vocabulary and matches over label name AND description, with NO
// loopover-specific keyword hardcoding (the #6794 inventory found loopover's own `gittensor:*` labels are the
// exception, not the shape to generalize from). Never throws: any fetch/parse failure degrades a signal to
// `absent`/`unknown` rather than erroring, so an unreachable or docs-less repo yields a low-confidence profile.
import { CONTRIBUTION_PROFILE_SCHEMA_VERSION, emptyContributionProfile, weakestConfidence, } from "./contribution-profile.js";
import { fetchWithRetry } from "./http-retry.js";
const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 10_000;
/** A CONTRIBUTING.md smaller than this is treated as a signpost (a link to an external guide), not the rules
 *  themselves — #6794 found react's is 208 B and kubernetes' 525 B, both just pointers. */
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
        response = await fetchWithRetry(fetchImpl, url, { method: "GET", headers }, { ...(sleepFn !== undefined ? { sleepFn } : {}), timeoutMs: REQUEST_TIMEOUT_MS });
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
    const labelObj = label;
    const rawName = typeof labelObj.name === "string" ? labelObj.name : "";
    const name = rawName.toLowerCase();
    const description = typeof labelObj.description === "string" ? labelObj.description.toLowerCase() : "";
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
    const contents = payload;
    if (!payload || typeof contents.content !== "string" || contents.encoding !== "base64")
        return null;
    return Buffer.from(contents.content, "base64").toString("utf8");
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
    const generatedAt = typeof options.generatedAt === "string" ? options.generatedAt : new Date().toISOString();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtZXh0cmFjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvbnRyaWJ1dGlvbi1wcm9maWxlLWV4dHJhY3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUhBQWlIO0FBQ2pILDZHQUE2RztBQUM3Ryx5R0FBeUc7QUFDekcsOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyxnSEFBZ0g7QUFDaEgsT0FBTyxFQUNMLG1DQUFtQyxFQUNuQyx3QkFBd0IsRUFDeEIsaUJBQWlCLEdBTWxCLE1BQU0sMkJBQTJCLENBQUM7QUFDbkMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRWpELE1BQU0sb0JBQW9CLEdBQUcsd0JBQXdCLENBQUM7QUFDdEQsTUFBTSxrQkFBa0IsR0FBRyxZQUFZLENBQUM7QUFDeEMsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUM7QUFDbEM7MkZBQzJGO0FBQzNGLE1BQU0sK0JBQStCLEdBQUcsR0FBRyxDQUFDO0FBRTVDO2lGQUNpRjtBQUNqRixNQUFNLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDdEMsa0JBQWtCO0lBQ2xCLGtCQUFrQjtJQUNsQixhQUFhO0lBQ2IsYUFBYTtJQUNiLGNBQWM7SUFDZCxVQUFVO0lBQ1YsTUFBTTtJQUNOLFNBQVM7Q0FDVixDQUFDLENBQUM7QUFFSDs2RkFDNkY7QUFDN0YsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNwQyxTQUFTO0lBQ1QsU0FBUztJQUNULFNBQVM7SUFDVCxjQUFjO0lBQ2QsU0FBUztJQUNULFNBQVM7SUFDVCxjQUFjO0lBQ2Qsa0JBQWtCO0lBQ2xCLEtBQUs7SUFDTCxpQkFBaUI7SUFDakIsVUFBVTtDQUNYLENBQUMsQ0FBQztBQUVILG9FQUFvRTtBQUNwRSxNQUFNLGtCQUFrQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDdkMsVUFBVTtJQUNWLFNBQVM7SUFD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