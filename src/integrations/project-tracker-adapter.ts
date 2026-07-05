import { createInstallationToken } from "../github/app";
import { githubRateLimitAdmissionKeyForInstallation, makeInstallationOctokit } from "../github/client";
import { createIssueComment } from "../github/pr-actions";
import { termOverlap, tokenize, type CollisionTerms } from "../signals/engine";
import { errorMessage } from "../utils/json";

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
 * Pluggable project/milestone tracker backend (#3183). `GitHubMilestonesAdapter` below implements the
 * milestone half now; Projects v2 (#3184) and a Linear backend (#3186) implement the same interface without
 * reshaping the matching/suggestion logic that calls it.
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

// Bounded pagination for both the milestone list and the comment-marker search below (mirrors
// src/github/comments.ts's COMMENT_SEARCH_PAGE_LIMIT): 3 pages * 100 = 300 items is generously above any
// realistic open-milestone or PR-comment count, while still bounding worst-case GitHub API calls per PR event.
const GITHUB_LIST_PAGE_LIMIT = 3;

/** A positive-integer milestone/issue number as a string, or null if `value` isn't one. Guards against a
 *  malformed/forged `milestoneId` reaching GitHub's PATCH as `NaN` or a negative/zero number. */
function parsePositiveIntegerId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** GitHub REST implementation of {@link ProjectTrackerAdapter}. Only the Milestone half is real (#3183) --
 *  Projects v2 is GraphQL-only and needs a separate `organization_projects` App permission not yet granted, so
 *  those two methods are inert placeholders until #3184. */
export class GitHubMilestonesAdapter implements ProjectTrackerAdapter {
  // Inert placeholder until #3184 (Projects v2 needs GraphQL + a separate App permission).
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

  // Inert placeholder until #3184 (Projects v2 needs GraphQL + a separate App permission).
  async attachToProject(): Promise<ProjectTrackerAttachResult> {
    return { attached: false };
  }

  async attachToMilestone(ctx: ProjectTrackerContext, pullNumber: number, milestoneId: string): Promise<ProjectTrackerAttachResult> {
    const milestoneNumber = parsePositiveIntegerId(milestoneId);
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

// Stricter than the duplicate-PR collision gate's 0.58/2 (src/signals/engine.ts) -- misattaching a PR to the
// wrong milestone corrupts tracked progress, whereas a missed duplicate just skips an advisory note.
const MILESTONE_MATCH_MIN_SCORE = 0.65;
const MILESTONE_MATCH_MIN_SHARED = 3;

export type ProjectTrackerMatch = {
  milestone: ProjectTrackerRef;
  score: number;
  shared: number;
};

function termsFor(value: string): CollisionTerms {
  const terms = new Set(tokenize(value));
  return { terms, size: terms.size };
}

/**
 * Match PR title+body text against a list of open milestones (#3183), reusing the same tokenize/termOverlap
 * heuristic as duplicate-PR collision detection. Returns null on no match -- AND on an ambiguous multi-match
 * (more than one milestone clears the threshold): guessing between two plausible milestones is worse than
 * suggesting neither, since a maintainer can always link one manually.
 */
export function matchOpenMilestones(prTitle: string, prBody: string | null | undefined, milestones: ProjectTrackerRef[]): ProjectTrackerMatch | null {
  if (milestones.length === 0) return null;
  const prTerms = termsFor([prTitle, prBody ?? ""].join(" "));
  const candidates = milestones
    .map((milestone) => ({ milestone, ...termOverlap(prTerms, termsFor(milestone.title)) }))
    .filter((candidate) => candidate.score >= MILESTONE_MATCH_MIN_SCORE && candidate.shared >= MILESTONE_MATCH_MIN_SHARED);
  if (candidates.length !== 1) return null;
  const best = candidates[0];
  /* v8 ignore next -- defensive: candidates.length === 1 above guarantees index 0 exists. */
  if (!best) return null;
  return { milestone: best.milestone, score: best.score, shared: best.shared };
}

export const MILESTONE_SUGGEST_COMMENT_MARKER = "<!-- gittensory-milestone-suggest:v1 -->";

/** Code-formats a maintainer-authored title for safe Markdown embedding: backticks strip any literal backtick
 *  from the title (so it can't break out of the code span) rather than escaping them, since a broken-out title
 *  could otherwise re-enable `@mentions` or `**`/`_` emphasis the code span exists to neutralize. */
function codeFormat(title: string): string {
  return `\`${title.replace(/`/g, "")}\``;
}

function renderSuggestionComment(match: ProjectTrackerMatch): string {
  const confidencePercent = Math.round(match.score * 100);
  return [
    MILESTONE_SUGGEST_COMMENT_MARKER,
    `This PR looks like it's part of the ${codeFormat(match.milestone.title)} milestone (${confidencePercent}% title/body term overlap).`,
    "",
    "This is an advisory suggestion only — nothing has been attached automatically.",
  ].join("\n");
}

type IssueComment = {
  body?: string | null;
  user?: { type?: string; login?: string } | null;
};

/**
 * Best-effort, idempotent suggest-mode comment (#3183): posts ONCE per PR (never updates or reposts), so a
 * repeated sweep/webhook pass never spams the thread. Never calls attachToMilestone -- suggest mode only ever
 * comments; #3185 wires the real attach path behind the "auto" config value.
 */
export async function maybeSuggestMilestoneMatch(ctx: ProjectTrackerContext, pullNumber: number, prTitle: string, prBody: string | null | undefined): Promise<{ suggested: boolean }> {
  const adapter = new GitHubMilestonesAdapter();
  const milestones = await adapter.listOpenMilestones(ctx);
  const match = matchOpenMilestones(prTitle, prBody, milestones);
  if (!match) return { suggested: false };

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
    alreadyPosted = batch.some((comment) => comment.user?.type === "Bot" && comment.user.login?.toLowerCase() === botLogin.toLowerCase() && comment.body?.includes(MILESTONE_SUGGEST_COMMENT_MARKER));
    if (batch.length < 100) break;
  }
  if (alreadyPosted) return { suggested: false };

  await createIssueComment(ctx.env, ctx.installationId, ctx.repoFullName, pullNumber, renderSuggestionComment(match));
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
  mode: ProjectMilestoneMatchModeInput;
  deliveryId: string;
}): Promise<void> {
  if (!args.installationId) return;
  if (args.prState !== "open") return;
  if (!args.mode || args.mode === "off") return;
  await maybeSuggestMilestoneMatch({ env: args.env, installationId: args.installationId, repoFullName: args.repoFullName }, args.pullNumber, args.prTitle, args.prBody).catch((error) => {
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
