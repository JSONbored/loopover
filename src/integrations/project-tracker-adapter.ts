import { createInstallationToken } from "../github/app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "../github/client";
import { createIssueComment } from "../github/pr-actions";
import { findLinearNativeLink, LinearAdapter } from "./linear-adapter";
import { termOverlap, tokenize, type CollisionTerms } from "../signals/engine";
import { errorMessage, parsePositiveInt } from "../utils/json";

/** Repo-scoped context shared by every ProjectTrackerAdapter call (#3183). */
export type ProjectTrackerContext = {
  env: Env;
  installationId: number;
  repoFullName: string;
};

/** A single open Project or Milestone, normalized to a string `id` regardless of the backend's native ID shape
 *  (a GitHub Milestone's REST `number` vs. a GitHub Projects v2 GraphQL node ID vs. a Linear UUID). */
export type ProjectTrackerRef = {
  id: string;
  title: string;
};

export type ProjectTrackerAttachResult = {
  attached: boolean;
};

/**
 * Pluggable project/milestone tracker backend (#3183). `GitHubMilestonesAdapter` implements the milestone half;
 * `GitHubProjectsAdapter` (#3184) implements the Projects v2 half; a Linear backend (#3186) implements the same
 * interface without reshaping the matching/suggestion logic that calls it.
 */
export interface ProjectTrackerAdapter {
  listOpenProjects(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]>;
  listOpenMilestones(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]>;
  attachToProject(ctx: ProjectTrackerContext, pullNumber: number, projectId: string): Promise<ProjectTrackerAttachResult>;
  attachToMilestone(ctx: ProjectTrackerContext, pullNumber: number, milestoneId: string): Promise<ProjectTrackerAttachResult>;
}

function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || /\s/.test(repoFullName)) {
    throw new Error(`Invalid repository full name: ${repoFullName}`);
  }
  return { owner, repo };
}

type GitHubMilestone = {
  number: number;
  title: string;
};

// Bounded pagination for milestones, PR comments (marker search), and Projects v2 (GraphQL cursor pages) below
// (mirrors src/github/comments.ts's COMMENT_SEARCH_PAGE_LIMIT): 3 pages * 100 = 300 items is generously above
// any realistic open-milestone/open-project/PR-comment count, while still bounding worst-case API calls.
const GITHUB_LIST_PAGE_LIMIT = 3;

/** GitHub REST implementation of {@link ProjectTrackerAdapter}. Only the Milestone half is real (#3183) --
 *  Projects v2 lives in the separate {@link GitHubProjectsAdapter} (#3184), so those two methods are inert here. */
export class GitHubMilestonesAdapter implements ProjectTrackerAdapter {
  // Inert here -- see GitHubProjectsAdapter.
  async listOpenProjects(): Promise<ProjectTrackerRef[]> {
    return [];
  }

  async listOpenMilestones(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]> {
    const { owner, repo } = parseRepoFullName(ctx.repoFullName);
    const token = await createInstallationToken(ctx.env, ctx.installationId);
    const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
    const milestones: GitHubMilestone[] = [];
    for (let page = 1; page <= GITHUB_LIST_PAGE_LIMIT; page += 1) {
      const response = await octokit.request("GET /repos/{owner}/{repo}/milestones", {
        owner,
        repo,
        state: "open",
        per_page: 100,
        page,
      });
      const batch = response.data as GitHubMilestone[];
      milestones.push(...batch);
      if (batch.length < 100) break;
    }
    return milestones.map((milestone) => ({ id: String(milestone.number), title: milestone.title }));
  }

  // Inert here -- see GitHubProjectsAdapter.
  async attachToProject(): Promise<ProjectTrackerAttachResult> {
    return { attached: false };
  }

  async attachToMilestone(ctx: ProjectTrackerContext, pullNumber: number, milestoneId: string): Promise<ProjectTrackerAttachResult> {
    const milestoneNumber = parsePositiveInt(milestoneId);
    if (milestoneNumber === null) return { attached: false };
    const { owner, repo } = parseRepoFullName(ctx.repoFullName);
    const token = await createInstallationToken(ctx.env, ctx.installationId);
    const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo,
      issue_number: pullNumber,
      milestone: milestoneNumber,
    });
    return { attached: true };
  }
}

// ---------------------------------------------------------------------------------------------------------
// GitHub Projects v2 (#3184)
// ---------------------------------------------------------------------------------------------------------
//
// CONFIRMED PLATFORM LIMITATION (researched during #3184, not merely "unconfirmed community report"):
// GitHub Apps cannot read/write Projects v2 owned by a USER account at all, by design -- only
// ORGANIZATION-owned Projects v2 are reachable via an App's installation token. There is no App permission
// that substitutes for this; the only way to automate a user-owned board is a personal-access-token or
// user-to-server OAuth token acting AS that user, which is a materially different feature (secret storage,
// consent flow) out of scope here. Sources: docs.github.com/en/rest/authentication/permissions-required-for-github-apps
// (the "User permissions" category has no Projects entry at all), and community reports of GitHub Support
// confirming this (github.com/orgs/community/discussions/46681, /64849, /148529).
//
// listOpenProjects below therefore queries `repositoryOwner(login){ __typename ... on Organization { ... } }`
// in ONE GraphQL call: if the repo's owner is a User, `__typename` is "User" and the inline fragment simply
// contributes nothing (no projects, no error) -- this repo's owner not being an Organization degrades to the
// same "no open projects" result as an Organization with zero open projects, never a thrown error. A separate,
// SEPARATE known gap (community-reported, not independently re-verified here since it requires a real private
// Projects v2 board to test against): a GitHub App's Bot actor may be unable to read items in a PRIVATE
// Projects v2 board even when the Organization-level permission is granted (github.com/orgs/community/discussions/148529).
// Both gaps degrade the SAME way -- an empty projects list, never a crash or a wrong match -- so no special
// handling is needed to stay safe; only visibility (this comment + the PR notes) documents the gap.

type ProjectV2Node = { id: string; title: string; closed: boolean };

type ListOpenProjectsGraphQlResponse = {
  repositoryOwner: {
    __typename: string;
    projectsV2?: { nodes: ProjectV2Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  } | null;
};

type ProjectV2FieldOption = { id: string; name: string };
type ProjectV2Field = { id: string; name: string; options?: ProjectV2FieldOption[] };

type ProjectFieldsGraphQlResponse = {
  node: {
    fields?: { nodes: ProjectV2Field[] };
  } | null;
};

type AddProjectV2ItemGraphQlResponse = {
  addProjectV2ItemById: { item: { id: string } | null } | null;
};

type PullRequestNodeIdResponse = {
  node_id: string;
};

/**
 * A single Projects v2 field's resolved options (#3184 deliverable: field/option-ID resolution, exposed for
 * #3185's auto-apply status-setting, not yet called by attachToProject -- adding a project item and setting a
 * custom field are two independent GraphQL mutations, and this PR only needs the first).
 */
export async function resolveProjectV2Fields(ctx: ProjectTrackerContext, projectId: string): Promise<ProjectV2Field[]> {
  if (typeof projectId !== "string" || projectId.trim().length === 0) return [];
  const token = await createInstallationToken(ctx.env, ctx.installationId);
  const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
  const response = await octokit.graphql<ProjectFieldsGraphQlResponse>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      }
    }`,
    { projectId },
  );
  return response.node?.fields?.nodes ?? [];
}

/** GraphQL implementation of {@link ProjectTrackerAdapter} for GitHub Projects v2 (#3184). Only the Project
 *  half is real -- Milestones live in the separate {@link GitHubMilestonesAdapter} (#3183), so those two
 *  methods are inert here. See the module-level comment above for the user-vs-organization-owner limitation. */
export class GitHubProjectsAdapter implements ProjectTrackerAdapter {
  async listOpenProjects(ctx: ProjectTrackerContext): Promise<ProjectTrackerRef[]> {
    const { owner } = parseRepoFullName(ctx.repoFullName);
    const token = await createInstallationToken(ctx.env, ctx.installationId);
    const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
    const projects: ProjectV2Node[] = [];
    let after: string | null = null;
    for (let page = 1; page <= GITHUB_LIST_PAGE_LIMIT; page += 1) {
      const response: ListOpenProjectsGraphQlResponse = await octokit.graphql(
        `query($login: String!, $after: String) {
          repositoryOwner(login: $login) {
            __typename
            ... on Organization {
              projectsV2(first: 100, after: $after, orderBy: {field: TITLE, direction: ASC}) {
                nodes { id title closed }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { login: owner, after },
      );
      const projectsV2 = response.repositoryOwner?.projectsV2;
      if (!projectsV2) break; // owner is a User (or has zero projects) -- see the module-level comment above.
      projects.push(...projectsV2.nodes.filter((project) => !project.closed));
      if (!projectsV2.pageInfo.hasNextPage) break;
      after = projectsV2.pageInfo.endCursor;
    }
    return projects.map((project) => ({ id: project.id, title: project.title }));
  }

  // Inert here -- see GitHubMilestonesAdapter.
  async listOpenMilestones(): Promise<ProjectTrackerRef[]> {
    return [];
  }

  async attachToProject(ctx: ProjectTrackerContext, pullNumber: number, projectId: string): Promise<ProjectTrackerAttachResult> {
    if (typeof projectId !== "string" || projectId.trim().length === 0) return { attached: false };
    const { owner, repo } = parseRepoFullName(ctx.repoFullName);
    const token = await createInstallationToken(ctx.env, ctx.installationId);
    const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
    const pr = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: pullNumber });
    const contentId = (pr.data as PullRequestNodeIdResponse).node_id;
    const response = await octokit.graphql<AddProjectV2ItemGraphQlResponse>(
      `mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item { id }
        }
      }`,
      { projectId, contentId },
    );
    return { attached: response.addProjectV2ItemById?.item != null };
  }

  // Inert here -- see GitHubMilestonesAdapter.
  async attachToMilestone(): Promise<ProjectTrackerAttachResult> {
    return { attached: false };
  }
}

// Stricter than the duplicate-PR collision gate's 0.58/2 (src/signals/engine.ts) -- misattaching a PR to the
// wrong tracker item corrupts tracked progress, whereas a missed duplicate just skips an advisory note.
const TRACKER_MATCH_MIN_SCORE = 0.65;
const TRACKER_MATCH_MIN_SHARED = 3;

export type ProjectTrackerMatch = {
  item: ProjectTrackerRef;
  // "native" (#3186): a CONFIRMED link (e.g. Linear's own GitHub integration already linked this PR), not a
  // guess -- score is fixed at 1 and shared is not applicable (0). "fuzzy": the tokenize/termOverlap heuristic.
  source: "fuzzy" | "native";
  score: number;
  shared: number;
};

function termsFor(value: string): CollisionTerms {
  const terms = new Set(tokenize(value));
  return { terms, size: terms.size };
}

/**
 * Match PR title+body text against a list of open tracker items (milestones OR projects -- #3183/#3184),
 * reusing the same tokenize/termOverlap heuristic as duplicate-PR collision detection. Returns null on no
 * match -- AND on an ambiguous multi-match (more than one item clears the threshold): guessing between two
 * plausible items is worse than suggesting neither, since a maintainer can always link one manually.
 */
export function matchOpenTrackerItems(prTitle: string, prBody: string | null | undefined, items: ProjectTrackerRef[]): ProjectTrackerMatch | null {
  if (items.length === 0) return null;
  const prTerms = termsFor([prTitle, prBody ?? ""].join(" "));
  const candidates = items
    .map((item) => ({ item, ...termOverlap(prTerms, termsFor(item.title)) }))
    .filter((candidate) => candidate.score >= TRACKER_MATCH_MIN_SCORE && candidate.shared >= TRACKER_MATCH_MIN_SHARED);
  if (candidates.length !== 1) return null;
  const best = candidates[0];
  /* v8 ignore next -- defensive: candidates.length === 1 above guarantees index 0 exists. */
  if (!best) return null;
  return { item: best.item, source: "fuzzy", score: best.score, shared: best.shared };
}

export const PROJECT_TRACKER_SUGGEST_COMMENT_MARKER = "<!-- gittensory-milestone-suggest:v1 -->";

/** Code-formats a maintainer-authored title for safe Markdown embedding: backticks strip any literal backtick
 *  from the title (so it can't break out of the code span) rather than escaping them, since a broken-out title
 *  could otherwise re-enable `@mentions` or `**`/`_` emphasis the code span exists to neutralize. */
function codeFormat(title: string): string {
  return `\`${title.replace(/`/g, "")}\``;
}

type ProjectTrackerMatches = {
  milestone: ProjectTrackerMatch | null;
  project: ProjectTrackerMatch | null;
};

function describeMatch(match: ProjectTrackerMatch, noun: "milestone" | "project"): string {
  if (match.source === "native") {
    return `This PR is linked to the ${codeFormat(match.item.title)} ${noun} (confirmed via Linear's GitHub integration).`;
  }
  return `This PR looks like it's part of the ${codeFormat(match.item.title)} ${noun} (${Math.round(match.score * 100)}% title/body term overlap).`;
}

function renderSuggestionComment(matches: ProjectTrackerMatches): string {
  const lines = [PROJECT_TRACKER_SUGGEST_COMMENT_MARKER];
  if (matches.milestone) lines.push(describeMatch(matches.milestone, "milestone"));
  if (matches.project) lines.push(describeMatch(matches.project, "project"));
  lines.push("", "This is an advisory suggestion only — nothing has been attached automatically.");
  return lines.join("\n");
}

type IssueComment = {
  body?: string | null;
  user?: { type?: string; login?: string } | null;
};

/** Only knows "github" vs. "linear" -- kept as a standalone alias (mirroring {@link ProjectMilestoneMatchModeInput}
 *  below) rather than importing RepositorySettings, so this integrations module has no dependency on the
 *  settings type. */
type ProjectMilestoneMatchBackendInput = "github" | "linear" | null | undefined;

/**
 * Resolves this PR's milestone/project matches against whichever backend the repo configured (#3186). The
 * Linear path tries {@link findLinearNativeLink} FIRST (a confirmed link via Linear's own GitHub integration
 * beats any guess) and only falls back to {@link matchOpenTrackerItems} fuzzy-matching against Linear's open
 * projects when no native link is found for either project or milestone. The GitHub path (default, #3183/#3184)
 * has no native-link concept -- it always fuzzy-matches both open Milestones and open Projects v2.
 */
async function resolveTrackerMatches(ctx: ProjectTrackerContext, backend: ProjectMilestoneMatchBackendInput, prTitle: string, prBody: string | null | undefined, prUrl: string): Promise<ProjectTrackerMatches> {
  if (backend === "linear") {
    const nativeLink = await findLinearNativeLink(ctx, prUrl);
    if (nativeLink.project || nativeLink.milestone) return nativeLink;
    const linearAdapter = new LinearAdapter();
    const projects = await linearAdapter.listOpenProjects(ctx);
    return { milestone: null, project: matchOpenTrackerItems(prTitle, prBody, projects) };
  }
  const milestonesAdapter = new GitHubMilestonesAdapter();
  const projectsAdapter = new GitHubProjectsAdapter();
  // Fail-open, independently, for each tracker type (mirrors this repo's established best-effort pattern):
  // a transient milestone REST error must never suppress a valid Projects v2 match, and vice versa -- either
  // lookup degrading to an empty list is a missed suggestion, not a broken one, matching the doc comment above.
  const [milestones, projects] = await Promise.all([milestonesAdapter.listOpenMilestones(ctx).catch(() => []), projectsAdapter.listOpenProjects(ctx).catch(() => [])]);
  return {
    milestone: matchOpenTrackerItems(prTitle, prBody, milestones),
    project: matchOpenTrackerItems(prTitle, prBody, projects),
  };
}

/**
 * Best-effort, idempotent suggest-mode comment (#3183/#3184/#3186): resolves matches against the repo's
 * configured backend (GitHub by default, Linear when opted in) and posts ONE comment naming whichever
 * matched, ONCE per PR (never updates or reposts), so a repeated sweep/webhook pass never spams the thread.
 * Never calls attachToMilestone/attachToProject -- suggest mode only ever comments; #3185 wires the real
 * attach path behind "auto".
 */
export async function maybeSuggestProjectOrMilestoneMatch(
  ctx: ProjectTrackerContext,
  pullNumber: number,
  prTitle: string,
  prBody: string | null | undefined,
  backend: ProjectMilestoneMatchBackendInput,
  prUrl: string,
): Promise<{ suggested: boolean }> {
  const matches = await resolveTrackerMatches(ctx, backend, prTitle, prBody, prUrl);
  if (!matches.milestone && !matches.project) return { suggested: false };

  const { owner, repo } = parseRepoFullName(ctx.repoFullName);
  const token = await createInstallationToken(ctx.env, ctx.installationId);
  const octokit = makeInstallationOctokit(ctx.env, token, "live", githubRateLimitAdmissionKeyForInstallation(ctx.installationId));
  const botLogin = `${ctx.env.GITHUB_APP_SLUG}[bot]`;
  let alreadyPosted = false;
  for (let page = 1; page <= GITHUB_LIST_PAGE_LIMIT && !alreadyPosted; page += 1) {
    const existing = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner,
      repo,
      issue_number: pullNumber,
      per_page: 100,
      page,
    });
    const batch = existing.data as IssueComment[];
    alreadyPosted = batch.some((comment) => comment.user?.type === "Bot" && comment.user.login?.toLowerCase() === botLogin.toLowerCase() && comment.body?.includes(PROJECT_TRACKER_SUGGEST_COMMENT_MARKER));
    if (batch.length < 100) break;
  }
  if (alreadyPosted) return { suggested: false };

  await createIssueComment(ctx.env, ctx.installationId, ctx.repoFullName, pullNumber, renderSuggestionComment(matches));
  return { suggested: true };
}

/**
 * Webhook-level entry point (#3183): folds the "should this even run" gating (installed app, PR still open,
 * feature opted in) AND the best-effort error logging into one call, so the PR-webhook handler in
 * processors.ts has a single, unconditional call site with no logic/logging body of its own -- everything
 * testable lives here, where it already has dedicated, isolated coverage, rather than in an inline closure
 * inside the huge webhook file that only a full pipeline test could exercise.
 */
export async function maybeSuggestMilestoneMatchForPr(args: {
  env: Env;
  installationId: number | null | undefined;
  repoFullName: string;
  pullNumber: number;
  prState: string;
  prTitle: string;
  prBody: string | null | undefined;
  prUrl: string | null | undefined;
  mode: ProjectMilestoneMatchModeInput;
  backend: ProjectMilestoneMatchBackendInput;
  deliveryId: string;
}): Promise<void> {
  if (!args.installationId) return;
  if (args.prState !== "open") return;
  if (!args.mode || args.mode === "off") return;
  await maybeSuggestProjectOrMilestoneMatch(
    { env: args.env, installationId: args.installationId, repoFullName: args.repoFullName },
    args.pullNumber,
    args.prTitle,
    args.prBody,
    args.backend,
    args.prUrl ?? "",
  ).catch((error) => {
    console.error(
      JSON.stringify({
        level: "warn",
        event: "milestone_suggest_failed",
        deliveryId: args.deliveryId,
        repoFullName: args.repoFullName,
        pullNumber: args.pullNumber,
        error: errorMessage(error),
      }),
    );
  });
}

// Kept as a standalone alias (rather than importing RepositorySettings from ../types) so this integrations
// module has no dependency on the settings type -- it only needs to know "off" vs. anything else.
type ProjectMilestoneMatchModeInput = "off" | "suggest" | "auto" | null | undefined;
