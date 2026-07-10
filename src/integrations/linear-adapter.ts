import { getDecryptedRepositoryLinearKey } from "../db/repositories";
import type { ProjectTrackerAdapter, ProjectTrackerAttachResult, ProjectTrackerContext, ProjectTrackerMatch, ProjectTrackerRef } from "./project-tracker-adapter";

const LINEAR_API_URL = "https://api.linear.app/graphql";

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
async function linearGraphQl<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear API HTTP ${response.status}`);
  const body = (await response.json()) as { data?: T } & LinearGraphQlErrorResponse;
  if (body.errors?.length) throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
  if (!body.data) throw new Error("Linear API returned no data");
  return body.data;
}

type LinearProjectNode = { id: string; name: string };
type LinearProjectMilestoneNode = { id: string; name: string };
type ListProjectsResponse = {
  projects: { nodes: LinearProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};
type ListProjectMilestonesResponse = {
  projectMilestones: { nodes: LinearProjectMilestoneNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

/**
 * GraphQL implementation of {@link ProjectTrackerAdapter} for Linear (#3186). Lists open workspace projects and
 * project-milestones for fuzzy fallback matching when Linear's own GitHub integration has not already linked
 * the PR via {@link findLinearNativeLink}. A confirmed native link still wins over any fuzzy guess.
 * `attachToProject`/`attachToMilestone` are inert: writing to Linear requires resolving or creating a Linear
 * Issue for this PR first, which is a materially bigger design question deferred beyond #3186's suggest-only scope.
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

  async listOpenMilestones(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]> {
    const apiKey = await getDecryptedRepositoryLinearKey(ctx.env, ctx.repoFullName);
    if (!apiKey) return [];
    const milestones: LinearProjectMilestoneNode[] = [];
    let after: string | null = null;
    for (let page = 1; page <= LINEAR_LIST_PAGE_LIMIT; page += 1) {
      const data: ListProjectMilestonesResponse = await linearGraphQl(
        apiKey,
        `query($after: String) {
          projectMilestones(first: 100, after: $after, includeArchived: false) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { after },
      );
      milestones.push(...data.projectMilestones.nodes);
      if (!data.projectMilestones.pageInfo.hasNextPage) break;
      after = data.projectMilestones.pageInfo.endCursor;
    }
    return milestones.map((milestone) => ({ id: milestone.id, title: milestone.name }));
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
export type LinearWorkspaceProbe = {
  reachable: boolean;
  openProjectCount: number;
  openMilestoneCount: number;
};

/**
 * Best-effort connectivity probe for a repo's configured Linear workspace (#3186). Used by maintainer
 * diagnostics to confirm a stored API key can list open projects/milestones before enabling the linear backend.
 * Never throws -- a misconfigured key or Linear outage returns `{ reachable: false, ... }`.
 */
export async function probeLinearWorkspaceAccess(ctx: ProjectTrackerContext): Promise<LinearWorkspaceProbe> {
  const apiKey = await getDecryptedRepositoryLinearKey(ctx.env, ctx.repoFullName);
  if (!apiKey) return { reachable: false, openProjectCount: 0, openMilestoneCount: 0 };
  const adapter = new LinearAdapter();
  try {
    const [projects, milestones] = await Promise.all([adapter.listOpenProjects(ctx), adapter.listOpenMilestones(ctx)]);
    return { reachable: true, openProjectCount: projects.length, openMilestoneCount: milestones.length };
  } catch {
    return { reachable: false, openProjectCount: 0, openMilestoneCount: 0 };
  }
}

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
