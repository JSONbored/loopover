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
        response = await fetchWithRetry(
        // `fetchWithRetry`'s `fetchFn` param takes `(url: unknown, init?: unknown)`; the ambient `fetch` type is
        // narrower on its input, so cast to the loose call shape this module actually uses (a GET returning a body
        // with `ok`/`status`/`json`) -- exactly what `opportunity-fanout.js`'s sibling `githubGetJson` relies on.
        fetchImpl, url, { method: "GET", headers }, { timeoutMs: REQUEST_TIMEOUT_MS, ...(sleepFn ? { sleepFn } : {}) });
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
    const l = label;
    const rawName = typeof l?.name === "string" ? l.name : "";
    const name = rawName.toLowerCase();
    const description = typeof l?.description === "string"
        ? l.description.toLowerCase()
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
    const p = payload;
    if (!p ||
        typeof p.content !== "string" ||
        p.encoding !== "base64")
        return null;
    return Buffer.from(p.content, "base64").toString("utf8");
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
 * Extract a best-effort ContributionProfile for a repo from its published label taxonomy and contribution docs.
 * Never throws: any fetch/parse failure degrades the relevant signal to `absent`/`unknown`. Generic — no
 * loopover-specific hardcoding.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29udHJpYnV0aW9uLXByb2ZpbGUtZXh0cmFjdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvbnRyaWJ1dGlvbi1wcm9maWxlLWV4dHJhY3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBY0EsT0FBTyxFQUNMLG1DQUFtQyxFQUNuQyx3QkFBd0IsRUFDeEIsaUJBQWlCLEdBQ2xCLE1BQU0sMkJBQTJCLENBQUM7QUFDbkMsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBRWpELE1BQU0sb0JBQW9CLEdBQUcsd0JBQXdCLENBQUM7QUFDdEQsTUFBTSxrQkFBa0IsR0FBRyxZQUFZLENBQUM7QUFDeEMsTUFBTSxrQkFBa0IsR0FBRyxNQUFNLENBQUM7QUFDbEM7MkZBQzJGO0FBQzNGLE1BQU0sK0JBQStCLEdBQUcsR0FBRyxDQUFDO0FBRTVDO2lGQUNpRjtBQUNqRixNQUFNLGlCQUFpQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDdEMsa0JBQWtCO0lBQ2xCLGtCQUFrQjtJQUNsQixhQUFhO0lBQ2IsYUFBYTtJQUNiLGNBQWM7SUFDZCxVQUFVO0lBQ1YsTUFBTTtJQUNOLFNBQVM7Q0FDVixDQUFDLENBQUM7QUFFSDs2RkFDNkY7QUFDN0YsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztJQUNwQyxTQUFTO0lBQ1QsU0FBUztJQUNULFNBQVM7SUFDVCxjQUFjO0lBQ2QsU0FBUztJQUNULFNBQVM7SUFDVCxjQUFjO0lBQ2Qsa0JBQWtCO0lBQ2xCLEtBQUs7SUFDTCxpQkFBaUI7SUFDakIsVUFBVTtDQUNYLENBQUMsQ0FBQztBQUVILG9FQUFvRTtBQUNwRSxNQUFNLGtCQUFrQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUM7SUFDdkMsVUFBVTtJQUNWLFNBQVM7SUFDVCxZQUFZO0lBQ1osY0FBYztJQUNkLG9CQUFvQjtJQUNwQixrQkFBa0I7Q0FDbkIsQ0FBQyxDQUFDO0FBRUgsU0FBUyxpQkFBaUIsQ0FB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