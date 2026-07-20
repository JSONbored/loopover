// Repo-agnostic AI issue planning (#7426, sub-issue of the ORB self-hoster planning epic #7424). Given a
// maintainer-supplied free-form goal, generates a small set of structured GitHub issue drafts (title/body/labels)
// for ANY repo the caller's App/Orb is installed on -- unlike generateContributorIssueDrafts (contributor-issue-
// draft.ts), which derives candidates purely from loopover-specific static signals (policy readiness, upstream
// drift, focus-manifest wanted paths) with zero LLM cost. This is genuinely generative: it calls the configured
// AI reviewer (mirroring review/planner.ts's `@loopover plan` shape) and is subject to the shared daily AI budget.
//
// Creates exclusively via the installation-token/Orb-broker path (src/github/issues.ts, #7425) -- never a flat
// PAT -- so it only works on a repo the caller's own App/Orb-brokered install actually covers.

import {
  type AiReviewActualUsage,
  BEST_REVIEW_MODELS,
  clampNumber,
  coerceAiText,
  coerceAiUsage,
  estimateNeurons,
  extractLastJsonObject,
  isEnabled,
  isRateLimitError,
  RELIABLE_FALLBACK_MODELS,
  utcDayStartIso,
} from "./ai-review";
import { createInstallationIssue } from "../github/issues";
import { createInstallationMilestone, listOpenInstallationMilestones } from "../github/milestones";
import { isMaintainerAssociation } from "../github/commands";
import {
  getRepository,
  isGlobalAgentFrozen,
  listClosedContributorDraftIssues,
  listOpenIssues,
  listRepoLabels,
  recordAiUsageEvent,
  recordAuditEvent,
  sumAiEstimatedNeuronsSince,
} from "../db/repositories";
import { isGlobalAgentPause } from "../settings/agent-execution";
import { isFocusManifestPublicSafe } from "../signals/focus-manifest";
import { normalizeIssueTitleKey } from "./contributor-issue-draft";
import type { IssueRecord } from "../types";
import { sha256Hex } from "../utils/crypto";
import { errorMessage, nowIso } from "../utils/json";

export const ISSUE_PLAN_DRAFT_MARKER_PREFIX = "loopover-issue-plan-draft";

export function issuePlanDraftMarker(fingerprint: string): string {
  return `<!-- ${ISSUE_PLAN_DRAFT_MARKER_PREFIX}:${fingerprint} -->`;
}

export async function issuePlanDraftFingerprint(repoFullName: string, titleKey: string): Promise<string> {
  return sha256Hex(`${ISSUE_PLAN_DRAFT_MARKER_PREFIX}:v1:${repoFullName.toLowerCase()}:${titleKey}`);
}

export type IssuePlanDraftStatus = "proposed" | "skipped_duplicate" | "skipped_declined" | "skipped_unsafe" | "created" | "skipped_create_failed";

export type IssuePlanDraft = {
  fingerprint: string;
  title: string;
  body: string;
  labels: string[];
  status: IssuePlanDraftStatus;
  duplicateOf?: { number: number; title: string; reason: "marker" | "title" } | undefined;
  declinedBy?: { number: number; title: string; reason: "wontfix" | "cooldown" } | undefined;
  issue?: { number: number; url: string } | undefined;
};

// Marker/title dedup, duplicated from contributor-issue-draft.ts's findDuplicateContributorDraft rather than
// imported: that function hardcodes CONTRIBUTOR_ISSUE_DRAFT_MARKER_PREFIX internally, so reusing it here would
// tag these AI-planned drafts with the wrong (misleading) marker family. normalizeIssueTitleKey itself has no
// prefix coupling and is imported directly.
export function findDuplicateIssuePlanDraft(
  openIssues: IssueRecord[],
  draft: Pick<IssuePlanDraft, "fingerprint" | "title">,
): { number: number; title: string; reason: "marker" | "title" } | null {
  const marker = issuePlanDraftMarker(draft.fingerprint);
  for (const issue of openIssues) {
    if (issue.state !== "open") continue;
    if (issue.body?.includes(marker)) return { number: issue.number, title: issue.title, reason: "marker" };
  }
  const titleKey = normalizeIssueTitleKey(draft.title);
  if (!titleKey) return null;
  for (const issue of openIssues) {
    if (issue.state !== "open") continue;
    if (normalizeIssueTitleKey(issue.title) === titleKey) return { number: issue.number, title: issue.title, reason: "title" };
  }
  return null;
}

export const ISSUE_PLAN_DRAFT_DECLINED_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const DECLINED_ISSUE_PLAN_WONTFIX_LABELS = new Set(["wontfix", "wont-fix", "invalid", "duplicate", "not-planned"]);

/** Mirrors contributor-issue-draft.ts's findDeclinedContributorDraft exactly (same wontfix/cooldown/maintainer-
 *  authorship contract) but keyed off this module's own marker family -- see findDuplicateIssuePlanDraft's doc. */
export function findDeclinedIssuePlanDraft(
  closedIssues: IssueRecord[],
  draft: Pick<IssuePlanDraft, "fingerprint">,
  options: { now?: number | undefined; cooldownMs?: number | undefined } = {},
): { number: number; title: string; reason: "wontfix" | "cooldown" } | null {
  const marker = issuePlanDraftMarker(draft.fingerprint);
  const nowMs = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? ISSUE_PLAN_DRAFT_DECLINED_COOLDOWN_MS;
  for (const issue of closedIssues) {
    if (issue.state !== "closed") continue;
    if (!issue.body?.includes(marker)) continue;
    if (issue.labels.some((label) => DECLINED_ISSUE_PLAN_WONTFIX_LABELS.has(label.trim().toLowerCase()))) {
      return { number: issue.number, title: issue.title, reason: "wontfix" };
    }
    if (!isMaintainerAssociation(issue.authorAssociation)) continue;
    const closedAtMs = issue.closedAt ? Date.parse(issue.closedAt) : Number.NaN;
    if (!Number.isFinite(closedAtMs) || nowMs - closedAtMs < cooldownMs) return { number: issue.number, title: issue.title, reason: "cooldown" };
  }
  return null;
}

const ISSUE_PLAN_SYSTEM_PROMPT = [
  "You are a senior open-source maintainer assistant. Given a repository's existing labels and a maintainer's",
  "planning goal, propose a SMALL set of concrete, actionable GitHub issues that move that goal forward. Respond",
  'with ONLY a JSON object of this exact shape: {"issues":[{"title":string,"body":string,"labels":string[]}]}.',
  "Each issue's body must be GitHub-flavored markdown with a one-line **Summary**, a **Proposed approach**",
  "(2-4 bullets), and **Acceptance criteria**. Prefer reusing the repository's existing labels over inventing new",
  "ones; only propose a new label when none of the existing ones fit. Keep each issue narrowly scoped -- one",
  "coherent change per issue, not a mega-issue. Never invent file paths you are not reasonably confident about.",
  "Do NOT include secrets, credentials, tokens, wallet/hotkey/coldkey details, trust scores, reward or payout",
  'figures, or any private data. If the goal is too vague to plan from, respond with {"issues":[]}.',
].join(" ");

const MAX_GOAL_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 4_000;
const MAX_LABELS_PER_DRAFT = 4;
const MAX_EXISTING_LABELS_IN_PROMPT = 40;
// Needs room for several full issue bodies at once, unlike the planner's single-plan PLANNER_MAX_TOKENS=1_200.
const ISSUE_PLAN_MAX_TOKENS = 3_000;
const ISSUE_PLAN_MODEL_COUNT = 4;
const DEFAULT_LIMIT = 5;
// Lower than contributor-issue-draft.ts's static MAX_LIMIT=20: every draft here costs real LLM spend, the static
// generator's candidates cost none.
const MAX_LIMIT = 10;

function issuePlanDailyBudget(env: Env): number {
  const raw = Number(env.AI_DAILY_NEURON_BUDGET);
  return clampNumber(env.AI_DAILY_NEURON_BUDGET && Number.isFinite(raw) ? raw : 10_000_000, 0, 10_000_000);
}

async function recordIssuePlanUsage(
  env: Env,
  args: {
    repoFullName: string;
    requestedBy?: string | null | undefined;
    status: string;
    estimatedNeurons: number;
    detail: string;
    usage?: AiReviewActualUsage | undefined;
  },
): Promise<void> {
  await recordAiUsageEvent(env, {
    feature: "issue_plan_drafts",
    actor: args.requestedBy ?? null,
    route: "mcp.issue_plan_drafts",
    model: [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]].join("+"),
    status: args.status,
    estimatedNeurons: args.estimatedNeurons,
    provider: args.usage?.provider,
    effort: args.usage?.effort,
    inputTokens: args.usage?.inputTokens,
    outputTokens: args.usage?.outputTokens,
    totalTokens: args.usage?.totalTokens,
    costUsd: args.usage?.costUsd,
    detail: args.detail,
    metadata: { repoFullName: args.repoFullName },
  });
}

type RawIssuePlanCandidate = { title?: unknown; body?: unknown; labels?: unknown };
type IssuePlanModelResult = { issues: RawIssuePlanCandidate[]; usage?: AiReviewActualUsage | undefined };

function parseIssuePlanModelOutput(text: string): RawIssuePlanCandidate[] {
  const jsonText = extractLastJsonObject(text);
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as { issues?: unknown };
    if (!Array.isArray(parsed.issues)) return [];
    return parsed.issues.filter((entry): entry is RawIssuePlanCandidate => typeof entry === "object" && entry !== null);
  } catch {
    return [];
  }
}

/** One reviewer completion for the issue planner (whichever provider `env.AI` resolves to). Mirrors
 *  review/planner.ts's runPlannerModel exactly: primary model, one reliable fallback, a single retry each,
 *  short-circuiting retries on a rate limit so a 429 doesn't burn the remaining attempt budget for zero chance
 *  of success. Fail-safe -- any error or unparseable/empty output returns no issues. */
async function runIssuePlanModel(env: Env, system: string, user: string): Promise<IssuePlanModelResult> {
  const ai = env.AI as unknown as { run?: (model: string, options: Record<string, unknown>, extra?: unknown) => Promise<unknown> } | undefined;
  if (!ai || typeof ai.run !== "function") return { issues: [] };
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const extra = gatewayId ? { gateway: { id: gatewayId } } : undefined;
  const models = [BEST_REVIEW_MODELS[0], RELIABLE_FALLBACK_MODELS[0]];
  for (const [modelIndex, model] of models.entries()) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await ai.run(
          model,
          {
            max_tokens: ISSUE_PLAN_MAX_TOKENS,
            temperature: 0.2,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            finalAttempt: attempt === 1 && modelIndex === models.length - 1,
          },
          extra,
        );
        const issues = parseIssuePlanModelOutput(coerceAiText(result));
        if (issues.length > 0) return { issues, usage: coerceAiUsage(result) };
      } catch (error) {
        if (isRateLimitError(error)) break;
      }
    }
  }
  return { issues: [] };
}

function buildIssuePlanUserPrompt(goal: string, existingLabelNames: string[]): string {
  const labelsLine = existingLabelNames.length > 0 ? existingLabelNames.slice(0, MAX_EXISTING_LABELS_IN_PROMPT).join(", ") : "(no labels configured yet)";
  return `Planning goal:\n${goal}\n\nRepository's existing labels (prefer reusing these):\n${labelsLine}`;
}

function normalizeIssuePlanCandidate(raw: RawIssuePlanCandidate): { title: string; body: string; labels: string[] } | null {
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, MAX_TITLE_CHARS) : "";
  const body = typeof raw.body === "string" ? raw.body.trim().slice(0, MAX_BODY_CHARS) : "";
  if (!title || !body) return null;
  const labels = Array.isArray(raw.labels)
    ? [...new Set(raw.labels.filter((label): label is string => typeof label === "string" && label.trim().length > 0).map((label) => label.trim()))].slice(0, MAX_LABELS_PER_DRAFT)
    : [];
  return { title, body, labels };
}

/** Creates via the installation-token/Orb-broker path (#7425) -- never a flat PAT -- so a missing installation
 *  fails closed exactly like contributor-issue-draft.ts's createGitHubContributorIssue. Catches broadly: Octokit
 *  throws on a non-2xx response or a malformed repoFullName, and this function's callers rely on a null return
 *  (never a throw) to mark a draft skipped_create_failed instead of failing the whole batch. */
async function createIssuePlanDraftIssue(
  env: Env,
  repoFullName: string,
  draft: Pick<IssuePlanDraft, "title" | "body" | "labels">,
  installationId: number | null | undefined,
  milestoneNumber: number | undefined,
): Promise<{ number: number; url: string } | null> {
  if (!installationId) return null;
  try {
    return await createInstallationIssue(env, installationId, repoFullName, { title: draft.title, body: draft.body, labels: draft.labels, milestone: milestoneNumber });
  } catch (error) {
    console.warn(
      JSON.stringify({ level: "warn", event: "issue_plan_draft_create_failed", repoFullName, message: errorMessage(error).slice(0, 200) }),
    );
    return null;
  }
}

export type IssuePlanMilestoneTarget = { title: string; description?: string | undefined; dueOn?: string | undefined };

/**
 * Resolve-or-create a milestone for the batch about to be created (#7427). Reuse is an EXACT normalized-title
 * match against existing OPEN milestones only (normalizeIssueTitleKey, already generic despite living on the
 * issue-draft side) -- deliberately not fuzzy: a fuzzy match risks silently grouping issues under the wrong
 * milestone, which is worse than creating a new, differently-named one. Mirrors the manual convention
 * `.claude/skills/contributor-pipeline-gardening` already follows (reusing one milestone across recurring
 * rounds) instead of spawning a fresh one every planning run under the same title.
 *
 * Degrades to null on ANY failure (including a malformed/suppressed create) rather than aborting the batch --
 * the maintainer still gets their issues, just ungrouped, which is preferable to filing nothing at all over a
 * milestone-specific glitch. Titles/descriptions/due dates are the CALLER's own input, never model-generated
 * (see the epic's #7427 boundary: milestone metadata is maintainer-authored/approved, not invented by the AI).
 */
async function resolveOrCreateIssuePlanMilestone(
  env: Env,
  installationId: number,
  repoFullName: string,
  target: IssuePlanMilestoneTarget,
): Promise<number | undefined> {
  try {
    const titleKey = normalizeIssueTitleKey(target.title);
    if (titleKey) {
      const existing = await listOpenInstallationMilestones(env, installationId, repoFullName);
      const match = existing.find((milestone) => normalizeIssueTitleKey(milestone.title) === titleKey);
      if (match) return match.number;
    }
    const created = await createInstallationMilestone(env, installationId, repoFullName, { title: target.title, description: target.description, dueOn: target.dueOn });
    return created?.number;
  } catch (error) {
    console.warn(
      JSON.stringify({ level: "warn", event: "issue_plan_milestone_resolve_failed", repoFullName, message: errorMessage(error).slice(0, 200) }),
    );
    return undefined;
  }
}

export type IssuePlanDraftOptions = {
  dryRun?: boolean | undefined;
  create?: boolean | undefined;
  limit?: number | undefined;
  requestedBy?: string | undefined;
  /** Optional milestone to resolve-or-create and assign created issues to (#7427). Only ever consulted when
   *  actually creating ({create:true, dryRun:false}) -- a dry-run preview makes no GitHub calls for it at all. */
  milestone?: IssuePlanMilestoneTarget | undefined;
};

export type IssuePlanGenerationStatus = "ok" | "disabled" | "unavailable" | "quota_exceeded" | "no_output";

export type IssuePlanGenerationResult = {
  repoFullName: string;
  generatedAt: string;
  status: IssuePlanGenerationStatus;
  dryRun: boolean;
  createRequested: boolean;
  proposed: number;
  skippedDuplicate: number;
  skippedDeclined: number;
  skippedUnsafe: number;
  created: number;
  skippedCreateFailed: number;
  drafts: IssuePlanDraft[];
  /** Set only when a milestone was actually resolved-or-created this call (i.e. a milestone target was given
   *  AND creation actually ran AND resolution succeeded). Absent on a dry run, a disabled/unavailable/quota
   *  short-circuit, no milestone requested, or a degraded (failed) resolution. */
  milestoneNumber?: number | undefined;
};

function emptyIssuePlanResult(
  repoFullName: string,
  generatedAt: string,
  status: IssuePlanGenerationStatus,
  dryRun: boolean,
  createRequested: boolean,
): IssuePlanGenerationResult {
  return { repoFullName, generatedAt, status, dryRun, createRequested, proposed: 0, skippedDuplicate: 0, skippedDeclined: 0, skippedUnsafe: 0, created: 0, skippedCreateFailed: 0, drafts: [] };
}

/**
 * AI-plan a small set of GitHub issue drafts for `repoFullName` from a maintainer-supplied free-form `goal`.
 * Defaults to dryRun (preview only); an explicit {create:true, dryRun:false} is required to actually write to
 * GitHub, via the installation-token/Orb-broker path only (#7425) -- there is no flat-PAT fallback, so a repo
 * with no installation degrades every draft to skipped_create_failed rather than failing this call outright.
 *
 * Unlike review/planner.ts's generateIssuePlan (which relies purely on its OWN dedicated isPlannerEnabled/
 * settings.plannerMode gate, checked by its webhook-triggered caller), this function has no per-repo enable
 * flag of its own -- it is opt-in simply by a maintainer calling the MCP tool that wraps it. It still checks the
 * SAME fleet-wide AI_SUMMARIES_ENABLED/AI_PUBLIC_COMMENTS_ENABLED kill switches runLoopOverAiReview uses, so an
 * operator who has globally disabled AI-generated public content is never surprised by this tool posting any --
 * a reasonable substitute for a dedicated flag given this capability's primary safety layer is the MCP access
 * check (requireRepoManageAccess), not fleet-wide default-off config-as-code.
 */
export async function generateIssuePlanDrafts(env: Env, repoFullName: string, goal: string, options: IssuePlanDraftOptions = {}): Promise<IssuePlanGenerationResult> {
  const generatedAt = nowIso();
  const dryRun = options.dryRun !== false || isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env));
  const createRequested = options.create === true;
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const empty = (status: IssuePlanGenerationStatus) => emptyIssuePlanResult(repoFullName, generatedAt, status, dryRun, createRequested);

  if (!isEnabled(env.AI_SUMMARIES_ENABLED) || !isEnabled(env.AI_PUBLIC_COMMENTS_ENABLED)) return empty("disabled");
  if (!env.AI) return empty("unavailable");

  const trimmedGoal = goal.trim().slice(0, MAX_GOAL_CHARS);
  if (!trimmedGoal) return empty("no_output");

  const [repo, openIssues, declinedIssues, labels] = await Promise.all([
    getRepository(env, repoFullName),
    listOpenIssues(env, repoFullName),
    listClosedContributorDraftIssues(env, repoFullName, `<!-- ${ISSUE_PLAN_DRAFT_MARKER_PREFIX}`),
    listRepoLabels(env, repoFullName),
  ]);

  const system = ISSUE_PLAN_SYSTEM_PROMPT;
  const user = buildIssuePlanUserPrompt(trimmedGoal, labels.map((label) => label.name));
  const estimatedNeurons = estimateNeurons(system.length + user.length, ISSUE_PLAN_MAX_TOKENS, ISSUE_PLAN_MODEL_COUNT);
  const remainingBudget = Math.max(0, issuePlanDailyBudget(env) - (await sumAiEstimatedNeuronsSince(env, utcDayStartIso())));
  if (estimatedNeurons > remainingBudget) {
    await recordIssuePlanUsage(env, { repoFullName, requestedBy: options.requestedBy, status: "quota_exceeded", estimatedNeurons: 0, detail: `estimated ${estimatedNeurons} neurons exceeds remaining ${remainingBudget}` });
    return empty("quota_exceeded");
  }

  const { issues: rawCandidates, usage } = await runIssuePlanModel(env, system, user);
  await recordIssuePlanUsage(env, {
    repoFullName,
    requestedBy: options.requestedBy,
    status: rawCandidates.length > 0 ? "ok" : "no_output",
    estimatedNeurons: rawCandidates.length > 0 ? estimatedNeurons : 0,
    detail: rawCandidates.length > 0 ? `${rawCandidates.length} issue draft(s) generated` : "no usable output",
    usage,
  });
  if (rawCandidates.length === 0) return empty("no_output");

  const milestoneNumber =
    !dryRun && createRequested && options.milestone && repo?.installationId
      ? await resolveOrCreateIssuePlanMilestone(env, repo.installationId, repoFullName, options.milestone)
      : undefined;

  const drafts: IssuePlanDraft[] = [];
  let proposed = 0;
  let skippedDuplicate = 0;
  let skippedDeclined = 0;
  let skippedUnsafe = 0;
  let created = 0;
  let skippedCreateFailed = 0;

  for (const rawCandidate of rawCandidates.slice(0, limit)) {
    const normalized = normalizeIssuePlanCandidate(rawCandidate);
    if (!normalized) continue; // malformed model output for this one entry -- skip silently, not a whole-batch failure

    const fingerprint = await issuePlanDraftFingerprint(repoFullName, normalizeIssueTitleKey(normalized.title) || normalized.title);
    const body = [
      issuePlanDraftMarker(fingerprint),
      "",
      normalized.body,
      "",
      "---",
      "*AI-generated from a maintainer-supplied planning goal. Review before relying on it; verify against the codebase.*",
    ].join("\n");
    const draft: IssuePlanDraft = { fingerprint, title: normalized.title, body, labels: normalized.labels, status: "proposed" };

    if (!isFocusManifestPublicSafe(draft.title) || !isFocusManifestPublicSafe(draft.body)) {
      draft.status = "skipped_unsafe";
      skippedUnsafe += 1;
      drafts.push(draft);
      continue;
    }
    const duplicate = findDuplicateIssuePlanDraft(openIssues, draft);
    if (duplicate) {
      draft.status = "skipped_duplicate";
      draft.duplicateOf = duplicate;
      skippedDuplicate += 1;
      drafts.push(draft);
      continue;
    }
    const declined = findDeclinedIssuePlanDraft(declinedIssues, draft);
    if (declined) {
      draft.status = "skipped_declined";
      draft.declinedBy = declined;
      skippedDeclined += 1;
      drafts.push(draft);
      continue;
    }

    if (!dryRun && createRequested) {
      const issue = await createIssuePlanDraftIssue(env, repoFullName, draft, repo?.installationId, milestoneNumber);
      if (issue) {
        draft.status = "created";
        draft.issue = issue;
        created += 1;
        openIssues.push({ repoFullName, number: issue.number, title: draft.title, state: "open", labels: draft.labels, linkedPrs: [], body: draft.body });
      } else {
        draft.status = "skipped_create_failed";
        skippedCreateFailed += 1;
      }
    } else {
      proposed += 1;
    }
    drafts.push(draft);
  }

  if (!dryRun && createRequested && created > 0) {
    await recordAuditEvent(env, {
      eventType: "issue_plan.drafts_created",
      outcome: "completed",
      metadata: { repoFullName, created, requestedBy: options.requestedBy ?? "mcp", fingerprints: drafts.filter((draft) => draft.status === "created").map((draft) => draft.fingerprint) },
    });
  }

  return { repoFullName, generatedAt, status: "ok", dryRun, createRequested, proposed, skippedDuplicate, skippedDeclined, skippedUnsafe, created, skippedCreateFailed, drafts, milestoneNumber };
}
