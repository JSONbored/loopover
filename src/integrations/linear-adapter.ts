import { getDecryptedRepositoryLinearKey } from "../db/repositories";
import type { ProjectTrackerAdapter, ProjectTrackerAttachResult, ProjectTrackerContext, ProjectTrackerMatch, ProjectTrackerRef } from "./project-tracker-adapter";

const LINEAR_API_URL = "https://api.linear.app/graphql";
// #9165 sweep: matches src/gittensor/api.ts's GITTENSOR_FETCH_TIMEOUT_MS -- a per-adapter timeout constant
// on every raw fetch() outside the shared GitHub client helpers, so a stalled Linear connection degrades
// this adapter's caller (falls back to fuzzy matching) instead of hanging.
const LINEAR_FETCH_TIMEOUT_MS = 10_000;

// "Open" for Linear means not-yet-completed and not-canceled -- listing the positive set (rather than
// excluding just "completed" via `neq`) so a canceled project is never mistaken for open. Bounded pagination
// (mirrors GitHubProjectsAdapter's GITHUB_LIST_PAGE_LIMIT): 3 pages * 100 = 300 is generously above any
// realistic open-project count.
const LINEAR_OPEN_PROJECT_STATUS_TYPES = ["backlog", "planned", "started", "paused"];
const LINEAR_LIST_PAGE_LIMIT = 3;

type LinearGraphQlErrorResponse = { errors?: { message: string }[] };

/** Raw POST to Linear's GraphQL endpoint (api.linear.app/graphql, no @octokit/graphql involved -- this is a
 *  wholly separate host/auth from every other adapter in this module). Auth is the raw API key with NO
 *  `Bearer` prefix (confirmed against linear.app/developers/graphql -- OAuth tokens use Bearer, personal API
 *  keys do not). Throws on a transport error or a GraphQL-level `errors` array so callers can treat any
 *  failure uniformly with a single `.catch()`. */
// #9319: bound a transient Linear 429 (its rate-limit status) with a small retry, mirroring the shape of
// src/github/client.ts's rate-limit retry but with Linear's own status/header semantics and local constants
// (this file's convention, like LINEAR_FETCH_TIMEOUT_MS). Small cap + capped backoff so the caller never hangs.
const LINEAR_RATE_LIMIT_MAX_RETRIES = 2;
const LINEAR_RATE_LIMIT_BASE_BACKOFF_MS = 500;
const LINEAR_RATE_LIMIT_MAX_BACKOFF_MS = 4_000;

/** Delay before retrying a Linear 429: honor a valid non-negative `Retry-After` (seconds) header when present,
 *  otherwise a capped exponential backoff. Always bounded by LINEAR_RATE_LIMIT_MAX_BACKOFF_MS. */
function linearRateLimitDelayMs(retryAfterHeader: string | null, attempt: number): number {
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(LINEAR_RATE_LIMIT_MAX_BACKOFF_MS, retryAfterSeconds * 1000);
  }
  return Math.min(LINEAR_RATE_LIMIT_MAX_BACKOFF_MS, LINEAR_RATE_LIMIT_BASE_BACKOFF_MS * 2 ** attempt);
}

async function linearGraphQl<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(LINEAR_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(LINEAR_FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = (await response.json()) as { data?: T } & LinearGraphQlErrorResponse;
      if (body.errors?.length) throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
      if (!body.data) throw new Error("Linear API returned no data");
      return body.data;
    }
    // A transient 429 gets a bounded retry; any other non-OK status (a genuine error) throws immediately, and
    // an exhausted 429 falls through to the same throw so the existing error contract is preserved.
    if (response.status === 429 && attempt < LINEAR_RATE_LIMIT_MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, linearRateLimitDelayMs(response.headers.get("retry-after"), attempt)));
      continue;
    }
    throw new Error(`Linear API HTTP ${response.status}`);
  }
}

type LinearProjectNode = { id: string; name: string };
type ListProjectsResponse = {
  projects: { nodes: LinearProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

/**
 * GraphQL implementation of {@link ProjectTrackerAdapter} for Linear (#3186). Lists open workspace projects for
 * fuzzy fallback matching when Linear's own GitHub integration has not already linked the PR via
 * {@link findLinearNativeLink}. A confirmed native link still wins over any fuzzy guess. Workspace-level Linear
 * project-milestones are deliberately not listed for fuzzy matching because their names may be internal to
 * unrelated private workspace work. `attachToProject`/`attachToMilestone` stay inert: writing to Linear
 * requires resolving or creating a Linear Issue for this PR first, deferred beyond #3186's suggest-only scope.
 */
export class LinearAdapter implements ProjectTrackerAdapter {
  async listOpenProjects(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]> {
    const apiKey = await getDecryptedRepositoryLinearKey(ctx.env, ctx.repoFullName);
    if (!apiKey) return [];
    const projects: LinearProjectNode[] = [];
    let after: string | null = null;
    for (let page = 1; page <= LINEAR_LIST_PAGE_LIMIT; page += 1) {
      const data: ListProjectsResponse = await linearGraphQl(
        apiKey,
        `query($statusTypes: [String!]!, $after: String) {
          projects(first: 100, after: $after, filter: { status: { type: { in: $statusTypes } } }) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { statusTypes: LINEAR_OPEN_PROJECT_STATUS_TYPES, after },
      );
      projects.push(...data.projects.nodes);
      if (!data.projects.pageInfo.hasNextPage) break;
      after = data.projects.pageInfo.endCursor;
    }
    return projects.map((project) => ({ id: project.id, title: project.name }));
  }

  async listOpenMilestones(): Promise<ProjectTrackerRef[]> {
    // Linear project-milestones are workspace-scoped, so fuzzy matching them against public PR text creates
    // an existence oracle for internal milestone names. Use only confirmed native links for Linear milestones.
    return [];
  }

  // Inert -- see the class doc comment above.
  async attachToProject(): Promise<ProjectTrackerAttachResult> {
    return { attached: false };
  }

  // Inert -- see the class doc comment above.
  async attachToMilestone(): Promise<ProjectTrackerAttachResult> {
    return { attached: false };
  }
}

type AttachmentsForUrlResponse = {
  attachmentsForURL: {
    nodes: {
      issue: {
        project: LinearProjectNode | null;
        projectMilestone: LinearProjectNode | null;
      } | null;
    }[];
  };
};

export type LinearNativeLinkResult = {
  project: ProjectTrackerMatch | null;
  milestone: ProjectTrackerMatch | null;
};

/**
 * Look up whether Linear's own GitHub integration has already linked `prUrl` to a Linear Issue (#3186), via
 * Linear's `attachmentsForURL` query -- the purpose-built lookup for exactly this (not the deprecated
 * `attachmentIssue`). When found, this is a CONFIRMED link, not a fuzzy guess, so the returned match carries
 * `source: "native"` (score 1, not a term-overlap percentage) -- the caller should prefer this over
 * `matchOpenTrackerItems` and only fall back to fuzzy matching when this returns nulls. Best-effort: returns
 * `{project: null, milestone: null}` on a missing key, a transport error, or no matching attachment/link --
 * never throws, so a Linear outage degrades to the fuzzy-matching fallback rather than blocking the feature.
 */
export async function findLinearNativeLink(ctx: ProjectTrackerContext, prUrl: string): Promise<LinearNativeLinkResult> {
  const none: LinearNativeLinkResult = { project: null, milestone: null };
  const apiKey = await getDecryptedRepositoryLinearKey(ctx.env, ctx.repoFullName);
  if (!apiKey) return none;
  const data = await linearGraphQl<AttachmentsForUrlResponse>(
    apiKey,
    `query($url: String!) {
      attachmentsForURL(url: $url) {
        nodes { issue { project { id name } projectMilestone { id name } } }
      }
    }`,
    { url: prUrl },
  ).catch(() => null);
  if (!data) return none;
  const issue = data.attachmentsForURL.nodes.find((node) => node.issue !== null)?.issue;
  if (!issue) return none;
  return {
    project: issue.project ? { item: { id: issue.project.id, title: issue.project.name }, source: "native", score: 1, shared: 0 } : null,
    milestone: issue.projectMilestone ? { item: { id: issue.projectMilestone.id, title: issue.projectMilestone.name }, source: "native", score: 1, shared: 0 } : null,
  };
}
