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
    const rec = node;
    const nodeNumber = rec.number;
    if (!Number.isInteger(nodeNumber) || nodeNumber <= 0)
        return null;
    const state = normalizeIssueOrPrState(rec.state);
    if (state !== "open" && state !== "closed" && state !== "merged")
        return null;
    const login = rec.author?.login;
    const authorLogin = typeof login === "string" ? login : "";
    // GitHub's real PR creation timestamp (ISO 8601), when present -- null otherwise (never fabricated). Not
    // an ordering signal for the maintainer gate's own duplicate-cluster election (duplicate-winner.ts's own
    // doc explains why: a PR can be backdated by editing an old placeholder to add the linked issue later), but
    // it's the only real, publicly-observable claim-time proxy claim-conflict-resolver.js's own client-side
    // caller has for a THIRD-PARTY PR -- unlike loopover's own server, the miner has no continuous observation
    // history to derive a true "first linked" timestamp from.
    const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : null;
    return { number: nodeNumber, state, authorLogin, createdAt };
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
    /* v8 ignore next -- the global-fetch default is the production path; every test injects fetchImpl. */
    const fetchImpl = options.fetchImpl ?? fetch;
    const rawTimeout = options.requestTimeoutMs;
    const requestTimeoutMs = Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_REQUEST_TIMEOUT_MS;
    // Bounded so a stalled connection can't hang this "never throws" fetcher forever (#miner-github-read-timeouts):
    // a timeout falls into the SAME catch as any other transport failure, which the caller (checkSubmissionFreshness)
    // already treats as "live_state_unavailable" -- a fail-closed abort distinct from "issue_closed"/"already_addressed",
    // never confused with a confirmed-gone issue.
    let response;
    try {
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
    const rawNodes = issue?.closedByPullRequestsReferences?.nodes;
    const nodes = Array.isArray(rawNodes) ? rawNodes : [];
    const referencingPrs = nodes
        .map(normalizeReferencingPr)
        .filter((pr) => pr !== null);
    return { state, referencingPrs };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGl2ZS1pc3N1ZS1zbmFwc2hvdC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImxpdmUtaXNzdWUtc25hcHNob3QudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxpR0FBaUc7QUFDakcsZ0ZBQWdGO0FBQ2hGLDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsMkdBQTJHO0FBQzNHLDJCQUEyQjtBQWEzQixNQUFNLG1CQUFtQixHQUFHLGdDQUFnQyxDQUFDO0FBQzdELE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBQ3hDLE1BQU0sbUJBQW1CLEdBQUcsRUFBRSxDQUFDO0FBQy9CLE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDO0FBRTFDLE1BQU0seUJBQXlCLEdBQUc7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnQmpDLENBQUM7QUFFRixTQUFTLG9CQUFvQixDQUFDLFdBQStCO0lBQzNELE1BQU0sT0FBTyxHQUEyQjtRQUN0QyxNQUFNLEVBQUUsNkJBQTZCO1FBQ3JDLGNBQWMsRUFBRSxrQkFBa0I7UUFDbEMsWUFBWSxFQUFFLGdCQUFnQjtRQUM5QixzQkFBc0IsRUFBRSxrQkFBa0I7S0FDM0MsQ0FBQztJQUNGLE1BQU0sS0FBSyxHQUFHLE9BQU8sV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDeEUsSUFBSSxLQUFLO1FBQUUsT0FBTyxDQUFDLGFBQWEsR0FBRyxVQUFVLEtBQUssRUFBRSxDQUFDO0lBQ3JELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLFFBQWlCO0lBQ2hELE9BQU8sT0FBTyxRQUFRLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUNwRSxDQUFDO0FBRUQsU0FBUyxzQkFB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