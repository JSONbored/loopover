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
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function normalizeIssueOrPrState(rawState) {
  return typeof rawState === "string" ? rawState.toLowerCase() : "";
}

function normalizeReferencingPr(node) {
  if (!node || typeof node !== "object") return null;
  if (!Number.isInteger(node.number) || node.number <= 0) return null;
  const state = normalizeIssueOrPrState(node.state);
  if (state !== "open" && state !== "closed" && state !== "merged") return null;
  const authorLogin = typeof node.author?.login === "string" ? node.author.login : "";
  return { number: node.number, state, authorLogin };
}

function parseRepoFullName(repoFullName) {
  if (typeof repoFullName !== "string") return null;
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  return { owner, repo };
}

/**
 * Real fetchLiveIssueSnapshot implementation: the live-state answer AttemptDeps/SubmissionFreshnessDeps
 * need, built from a single GraphQL round-trip. Returns null on any malformed input, transport failure, or
 * unrecognized GitHub response -- callers already treat a null snapshot as "state unavailable", so this
 * never throws.
 *
 * @param {string} repoFullName
 * @param {number} issueNumber
 * @param {{ githubToken?: string, graphqlUrl?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<import("./submission-freshness-check.js").LiveIssueSnapshot | null>}
 */
export async function fetchLiveIssueSnapshot(repoFullName, issueNumber, options = {}) {
  const target = parseRepoFullName(repoFullName);
  if (!target || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;

  const graphqlUrl =
    typeof options.graphqlUrl === "string" && options.graphqlUrl.trim() ? options.graphqlUrl.trim() : DEFAULT_GRAPHQL_URL;
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  let response;
  try {
    response = await fetchImpl(graphqlUrl, {
      method: "POST",
      headers: githubGraphqlHeaders(githubToken),
      body: JSON.stringify({
        query: LIVE_ISSUE_SNAPSHOT_QUERY,
        variables: { owner: target.owner, repo: target.repo, number: issueNumber, maxPrs: MAX_REFERENCING_PRS },
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || payload.errors) return null;

  const issue = payload.data?.repository?.issue;
  const state = normalizeIssueOrPrState(issue?.state);
  if (state !== "open" && state !== "closed") return null;

  const nodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes) ? issue.closedByPullRequestsReferences.nodes : [];
  const referencingPrs = nodes.map(normalizeReferencingPr).filter((pr) => pr !== null);

  return { state, referencingPrs };
}
