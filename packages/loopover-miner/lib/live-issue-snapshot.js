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
    const pr = node;
    if (!Number.isInteger(pr.number) || pr.number <= 0)
        return null;
    const state = normalizeIssueOrPrState(pr.state);
    if (state !== "open" && state !== "closed" && state !== "merged")
        return null;
    const authorLogin = typeof pr.author?.login === "string" ? pr.author.login : "";
    // GitHub's real PR creation timestamp (ISO 8601), when present -- null otherwise (never fabricated). Not
    // an ordering signal for the maintainer gate's own duplicate-cluster election (duplicate-winner.ts's own
    // doc explains why: a PR can be backdated by editing an old placeholder to add the linked issue later), but
    // it's the only real, publicly-observable claim-time proxy claim-conflict-resolver.js's own client-side
    // caller has for a THIRD-PARTY PR -- unlike loopover's own server, the miner has no continuous observation
    // history to derive a true "first linked" timestamp from.
    const createdAt = typeof pr.createdAt === "string" ? pr.createdAt : null;
    return { number: pr.number, state: state, authorLogin, createdAt };
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
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutOption = options.requestTimeoutMs;
    const requestTimeoutMs = typeof timeoutOption === "number" && Number.isInteger(timeoutOption) && timeoutOption > 0
        ? timeoutOption
        : DEFAULT_REQUEST_TIMEOUT_MS;
    // Bounded so a stalled connection can't hang this "never throws" fetcher forever (#miner-github-read-timeouts):
    // a timeout falls into the SAME catch as any other transport failure, which the caller (checkSubmissionFreshness)
    // already treats as "live_state_unavailable" -- a fail-closed abort distinct from "issue_closed"/"already_addressed",
    // never confused with a confirmed-gone issue.
    let response;
    try {
        const init = {
            method: "POST",
            headers: githubGraphqlHeaders(githubToken),
            body: JSON.stringify({
                query: LIVE_ISSUE_SNAPSHOT_QUERY,
                variables: { owner: target.owner, repo: target.repo, number: issueNumber, maxPrs: MAX_REFERENCING_PRS },
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
        };
        response = await fetchImpl(graphqlUrl, init);
    }
    catch {
        return null;
    }
    if (!response.ok)
        return null;
    const payload = (await response.json().catch(() => null));
    if (!payload || typeof payload !== "object" || payload.errors)
        return null;
    const issue = payload.data?.repository?.issue;
    const state = normalizeIssueOrPrState(issue?.state);
    if (state !== "open" && state !== "closed")
        return null;
    const nodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes)
        ? issue.closedByPullRequestsReferences.nodes
        : [];
    const referencingPrs = nodes
        .map(normalizeReferencingPr)
        .filter((pr) => pr !== null);
    return { state: state, referencingPrs };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGl2ZS1pc3N1ZS1zbmFwc2hvdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxpdmUtaXNzdWUtc25hcHNob3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxpR0FBaUc7QUFDakcsZ0ZBQWdGO0FBQ2hGLDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsMkdBQTJHO0FBQzNHLDJCQUEyQjtBQWEzQixNQUFNLG1CQUFtQixHQUFHLGdDQUFnQyxDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBQ3hDLE1BQU0sbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBQy9CLE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDO0FBRTFDLE1BQU0seUJBQXlCLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQmpDLENBQUM7QUFxQkYsU0FBUyxvQkFBb0IsQ0FBQyxXQUFtQjtJQUMvQyxNQUFNLE9BQU8sR0FBMkI7UUFDdEMsTUFBTSxFQUFFLDZCQUE2QjtRQUNyQyxjQUFjLEVBQUUsa0JBQWtCO1FBQ2xDLFlBQVksRUFBRSxnQkFBZ0I7UUFDOUIsc0JBQXNCLEVBQUUsa0JBQWtCO0tBQzNDLENBQUM7SUFDRixNQUFNLEtBQUssR0FBRyxPQUFPLFdBQVcsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3hFLElBQUksS0FBSztRQUFFLE9BQU8sQ0FBQyxhQUFhLEdBQUcsVUFBVSxLQUFLLEVBQUUsQ0FBQztJQUNyRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxRQUFpQjtJQUNoRCxPQUFPLE9BQU8sUUFBUSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFdBQVcsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDcEUsQ0FBQztBQUVELFNBQVMsc0JB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