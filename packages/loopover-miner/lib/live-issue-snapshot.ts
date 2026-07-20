// Real GitHub-backed fetchLiveIssueSnapshot (#5132, Wave 3.5). AttemptDeps.fetchLiveIssueSnapshot and
// SubmissionFreshnessDeps.fetchLiveIssueSnapshot (submission-freshness-check.js) share this one shape:
// "is this issue still open, and is it already addressed by another PR" -- the live-state answer
// checkSubmissionFreshness needs before every submission. Uses GitHub's GraphQL
// `closedByPullRequestsReferences` connection rather than a body-text/search-API heuristic: it's GitHub's
// own authoritative, closing-keyword-aware answer to "which PRs will close this issue" -- the same signal
// the platform itself uses to auto-close on merge, not a regex we'd have to keep in sync with GitHub's own
// closing-keyword parsing.

import type { LiveIssueSnapshot } from "./submission-freshness-check.js";

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

// A narrower shape than `typeof fetch` on purpose: this module only ever calls it with a string URL and a
// plain POST init, and the ambient `fetch` type in this repo's TS program is Cloudflare-Workers-flavored
// (RequestInfo<CfProperties> | URL), which is both irrelevant here (this package runs under plain Node) and
// stricter than any real caller needs.
export type LiveIssueSnapshotFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

type LiveIssueSnapshotOptions = {
  githubToken?: string;
  graphqlUrl?: string;
  fetchImpl?: LiveIssueSnapshotFetch;
  requestTimeoutMs?: number;
};

type ReferencingPr = LiveIssueSnapshot["referencingPrs"][number];

function githubGraphqlHeaders(githubToken: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "loopover-miner",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  const token = typeof githubToken === "string" ? githubToken.trim() : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function normalizeIssueOrPrState(rawState: unknown): string {
  return typeof rawState === "string" ? rawState.toLowerCase() : "";
}

function normalizeReferencingPr(node: unknown): ReferencingPr | null {
  if (!node || typeof node !== "object") return null;
  const record = node as {
    number?: unknown;
    state?: unknown;
    author?: { login?: unknown };
    createdAt?: unknown;
  };
  if (!Number.isInteger(record.number) || (record.number as number) <= 0) return null;
  const state = normalizeIssueOrPrState(record.state);
  if (state !== "open" && state !== "closed" && state !== "merged") return null;
  const authorLogin = typeof record.author?.login === "string" ? record.author.login : "";
  // GitHub's real PR creation timestamp (ISO 8601), when present -- null otherwise (never fabricated). Not
  // an ordering signal for the maintainer gate's own duplicate-cluster election (duplicate-winner.ts's own
  // doc explains why: a PR can be backdated by editing an old placeholder to add the linked issue later), but
  // it's the only real, publicly-observable claim-time proxy claim-conflict-resolver.js's own client-side
  // caller has for a THIRD-PARTY PR -- unlike loopover's own server, the miner has no continuous observation
  // history to derive a true "first linked" timestamp from.
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
  return { number: record.number as number, state, authorLogin, createdAt };
}

function parseRepoFullName(repoFullName: unknown): { owner: string; repo: string } | null {
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
 */
export async function fetchLiveIssueSnapshot(
  repoFullName: string,
  issueNumber: number,
  options: LiveIssueSnapshotOptions = {},
): Promise<LiveIssueSnapshot | null> {
  const target = parseRepoFullName(repoFullName);
  if (!target || !Number.isInteger(issueNumber) || issueNumber <= 0) return null;

  const graphqlUrl =
    typeof options.graphqlUrl === "string" && options.graphqlUrl.trim() ? options.graphqlUrl.trim() : DEFAULT_GRAPHQL_URL;
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN ?? "";
  // Cast: ambient `fetch` is CF-Workers-flavored; the public inject seam is the narrower LiveIssueSnapshotFetch.
  const fetchImpl = (options.fetchImpl ?? fetch) as LiveIssueSnapshotFetch;
  const requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) && (options.requestTimeoutMs as number) > 0
    ? (options.requestTimeoutMs as number)
    : DEFAULT_REQUEST_TIMEOUT_MS;

  // Bounded so a stalled connection can't hang this "never throws" fetcher forever (#miner-github-read-timeouts):
  // a timeout falls into the SAME catch as any other transport failure, which the caller (checkSubmissionFreshness)
  // already treats as "live_state_unavailable" -- a fail-closed abort distinct from "issue_closed"/"already_addressed",
  // never confused with a confirmed-gone issue.
  let response: Awaited<ReturnType<LiveIssueSnapshotFetch>>;
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
    } as { method: string; headers: Record<string, string>; body: string });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || (payload as { errors?: unknown }).errors) return null;

  const issue = (payload as {
    data?: { repository?: { issue?: {
      state?: unknown;
      closedByPullRequestsReferences?: { nodes?: unknown };
    } } };
  }).data?.repository?.issue;
  const state = normalizeIssueOrPrState(issue?.state);
  if (state !== "open" && state !== "closed") return null;

  const nodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes)
    ? issue.closedByPullRequestsReferences.nodes
    : [];
  const referencingPrs = nodes.map(normalizeReferencingPr).filter((pr): pr is ReferencingPr => pr !== null);

  return { state, referencingPrs };
}
