// Real GitHub-backed fetchLiveIssueSnapshot (#5132, Wave 3.5). AttemptDeps.fetchLiveIssueSnapshot and
// SubmissionFreshnessDeps.fetchLiveIssueSnapshot (submission-freshness-check.js) share this one shape:
// "is this issue still open, and is it already addressed by another PR" -- the live-state answer
// checkSubmissionFreshness needs before every submission. Uses GitHub's GraphQL
// `closedByPullRequestsReferences` connection rather than a body-text/search-API heuristic: it's GitHub's
// own authoritative, closing-keyword-aware answer to "which PRs will close this issue" -- the same signal
// the platform itself uses to auto-close on merge, not a regex we'd have to keep in sync with GitHub's own
// closing-keyword parsing.
const DEFAULT_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_REFERENCING_PRS = 50;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const LIVE_ISSUE_SNAPSHOT_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $maxPrs: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        state
        closedByPullRequestsReferences(first: $maxPrs) {
          nodes {
            number
            state
            author { login }
            createdAt
          }
        }
      }
    }
  }
`;
function githubGraphqlHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "loopover-miner",
        "x-github-api-version": GITHUB_API_VERSION,
    };
    const token = typeof githubToken === "string" ? githubToken.trim() : "";
    if (token)
        headers.authorization = `Bearer ${token}`;
    return headers;
}
function normalizeIssueOrPrState(rawState) {
    return typeof rawState === "string" ? rawState.toLowerCase() : "";
}
function normalizeReferencingPr(node) {
    if (!node || typeof node !== "object")
        return null;
    const record = node;
    if (!Number.isInteger(record.number) || record.number <= 0)
        return null;
    const state = normalizeIssueOrPrState(record.state);
    if (state !== "open" && state !== "closed" && state !== "merged")
        return null;
    const authorLogin = typeof record.author?.login === "string" ? record.author.login : "";
    // GitHub's real PR creation timestamp (ISO 8601), when present -- null otherwise (never fabricated). Not
    // an ordering signal for the maintainer gate's own duplicate-cluster election (duplicate-winner.ts's own
    // doc explains why: a PR can be backdated by editing an old placeholder to add the linked issue later), but
    // it's the only real, publicly-observable claim-time proxy claim-conflict-resolver.js's own client-side
    // caller has for a THIRD-PARTY PR -- unlike loopover's own server, the miner has no continuous observation
    // history to derive a true "first linked" timestamp from.
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
    return { number: record.number, state, authorLogin, createdAt };
}
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        return null;
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    return { owner, repo };
}
/**
 * Real fetchLiveIssueSnapshot implementation: the live-state answer AttemptDeps/SubmissionFreshnessDeps
 * need, built from a single GraphQL round-trip. Returns null on any malformed input, transport failure, or
 * unrecognized GitHub response -- callers already treat a null snapshot as "state unavailable", so this
 * never throws.
 */
export async function fetchLiveIssueSnapshot(repoFullName, issueNumber, options = {}) {
    const target = parseRepoFullName(repoFullName);
    if (!target || !Number.isInteger(issueNumber) || issueNumber <= 0)
        return null;
    const graphqlUrl = typeof options.graphqlUrl === "string" && options.graphqlUrl.trim() ? options.graphqlUrl.trim() : DEFAULT_GRAPHQL_URL;
    const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? "";
    // Cast: ambient `fetch` is CF-Workers-flavored; the public inject seam is the narrower LiveIssueSnapshotFetch.
    const fetchImpl = (options.fetchImpl ?? fetch);
    const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) && options.requestTimeoutMs > 0
        ? options.requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS;
    // Bounded so a stalled connection can't hang this "never throws" fetcher forever (#miner-github-read-timeouts):
    // a timeout falls into the SAME catch as any other transport failure, which the caller (checkSubmissionFreshness)
    // already treats as "live_state_unavailable" -- a fail-closed abort distinct from "issue_closed"/"already_addressed",
    // never confused with a confirmed-gone issue.
    let response;
    try {
        // Cast: runtime always passes `signal`; the public LiveIssueSnapshotFetch init omits it (mock-friendly).
        response = await fetchImpl(graphqlUrl, {
            method: "POST",
            headers: githubGraphqlHeaders(githubToken),
            body: JSON.stringify({
                query: LIVE_ISSUE_SNAPSHOT_QUERY,
                variables: { owner: target.owner, repo: target.repo, number: issueNumber, maxPrs: MAX_REFERENCING_PRS },
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
    }
    catch {
        return null;
    }
    if (!response.ok)
        return null;
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== "object" || payload.errors)
        return null;
    const issue = payload.data?.repository?.issue;
    const state = normalizeIssueOrPrState(issue?.state);
    if (state !== "open" && state !== "closed")
        return null;
    const nodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes)
        ? issue.closedByPullRequestsReferences.nodes
        : [];
    const referencingPrs = nodes.map(normalizeReferencingPr).filter((pr) => pr !== null);
    return { state, referencingPrs };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGl2ZS1pc3N1ZS1zbmFwc2hvdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxpdmUtaXNzdWUtc25hcHNob3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxpR0FBaUc7QUFDakcsZ0ZBQWdGO0FBQ2hGLDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsMkdBQTJHO0FBQzNHLDJCQUEyQjtBQUkzQixNQUFNLG1CQUFtQixHQUFHLGdDQUFnQyxDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBQ3hDLE1BQU0sbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBQy9CLE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDO0FBRTFDLE1BQU0seUJBQXlCLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQmpDLENBQUM7QUFvQkYsU0FBUyxvQkFBb0IsQ0FBQyxXQUFvQjtJQUNoRCxNQUFNLE9BQU8sR0FBMkI7UUFDdEMsTUFBTSxFQUFFLDZCQUE2QjtRQUNyQyxjQUFjLEVBQUUsa0JBQWtCO1FBQ2xDLFlBQVksRUFBRSxnQkFBZ0I7UUFDOUIsc0JBQXNCLEVBQUUsa0JBQWtCO0tBQzNDLENBQUM7SUFDRixNQUFNLEtBQUssR0FBRyxPQUFPLFdBQVcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3hFLElBQUksS0FBSztRQUFFLE9BQU8sQ0FBQyxhQUFhLEdBQUcsVUFBVSxLQUFLLEVBQUUsQ0FBQztJQUNyRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxRQUFpQjtJQUNoRCxPQUFPLE9BQU8sUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDcEUsQ0FBQztBQUVELFNBQVMsc0JB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