import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpecContent,
  rankMetadataOpportunities,
} from "@loopover/engine";
import type { MinerGoalSpec } from "@loopover/engine";
import type { RawCandidateIssue } from "./opportunity-fanout.js";

export type RankedCandidateIssue = RawCandidateIssue & {
  potential: number;
  feasibility: number;
  laneFit: number;
  freshness: number;
  dupRisk: number;
  rankScore: number;
};

export type RankCandidateIssuesOptions = {
  nowMs?: number;
  highRiskDuplicateClusters?: number;
  openPullRequests?: number;
  goalSpecsByRepo?: Record<string, MinerGoalSpec>;
  goalSpecContentByRepo?: Record<string, string>;
};

export type RankedCandidateSummary = {
  issues: RankedCandidateIssue[];
  skippedInvalid: number;
  usedDefaultGoalSpec: boolean;
  defaultGoalSpec: MinerGoalSpec;
};

function finiteEpochMs(value: unknown): number {
  return Number.isFinite(value) ? (value as number) : Date.now();
}

function finiteNonNegativeInt(value: unknown): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value as number));
}

function normalizeCandidate(candidate: Record<string, unknown>) {
  if (!candidate || typeof candidate !== "object") return null;
  const repoFullName =
    typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
  const issueNumber = candidate.issueNumber as number;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !title) return null;
  const canonicalRepoFullName = `${owner}/${repo}`;
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels
        .filter((label) => typeof label === "string" && label.trim())
        .map((label) => label.trim())
    : [];
  // #9330: RankedCandidateIssue's `RawCandidateIssue &` type promises `assignees`, but this function
  // dropped it. Mirror `labels`'s array-of-strings validation; no `.trim()` because the producer
  // (opportunity-fanout.ts assigneeLogins) already emits clean GitHub logins filtered to length > 0.
  const assignees = Array.isArray(candidate.assignees)
    ? candidate.assignees.filter(
        (assignee): assignee is string => typeof assignee === "string" && assignee.length > 0,
      )
    : [];
  return {
    owner,
    repo,
    repoFullName: canonicalRepoFullName,
    issueNumber,
    title,
    labels,
    assignees,
    commentsCount: Number.isFinite(candidate.commentsCount) ? (candidate.commentsCount as number) : 0,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : null,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
    aiPolicyAllowed: candidate.aiPolicyAllowed !== false,
    aiPolicySource:
      candidate.aiPolicySource === "AI-USAGE.md" ||
      candidate.aiPolicySource === "CONTRIBUTING.md" ||
      candidate.aiPolicySource === "none"
        ? candidate.aiPolicySource
        : "none",
  };
}

type NormalizedCandidate = NonNullable<ReturnType<typeof normalizeCandidate>>;

function buildGoalSpecsByRepo(options: RankCandidateIssuesOptions = {}) {
  const goalSpecsByRepo: Record<string, MinerGoalSpec> = { ...(options.goalSpecsByRepo ?? {}) };
  const rawContentByRepo: Record<string, string> = options.goalSpecContentByRepo ?? {};
  for (const [repoFullName, content] of Object.entries(rawContentByRepo)) {
    if (typeof content !== "string" || !content.trim()) continue;
    goalSpecsByRepo[repoFullName] = parseMinerGoalSpecContent(content).spec;
  }
  return goalSpecsByRepo;
}

function buildRankContext(options: RankCandidateIssuesOptions = {}) {
  return {
    nowMs: finiteEpochMs(options.nowMs),
    highRiskDuplicateClusters: finiteNonNegativeInt(options.highRiskDuplicateClusters),
    openPullRequests: finiteNonNegativeInt(options.openPullRequests),
    goalSpecsByRepo: buildGoalSpecsByRepo(options),
  };
}

function collectCandidates(candidates: RawCandidateIssue[]) {
  const input = Array.isArray(candidates) ? candidates : [];
  let skippedInvalid = 0;
  const normalized: NormalizedCandidate[] = [];
  const seen = new Set();
  for (const candidate of input) {
    const entry = normalizeCandidate(candidate);
    if (!entry) {
      skippedInvalid += 1;
      continue;
    }
    const key = `${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return { normalized, skippedInvalid };
}

function rankedUsesDefaultGoalSpec(ranked: RankedCandidateIssue[], options: RankCandidateIssuesOptions = {}) {
  const goalSpecsByRepo = buildGoalSpecsByRepo(options);
  const specRepos = Object.keys(goalSpecsByRepo);
  if (ranked.length === 0) return specRepos.length === 0;
  // The "ranked with the built-in default goal spec (no per-tenant .loopover-miner.yml supplied)" note is only
  // truthful when the WHOLE batch fell back to the default -- so require EVERY ranked repo to lack a supplied spec,
  // not just any one of them (#7226). With `.some`, a single spec-less repo made a mixed batch (where other repos
  // genuinely had a spec supplied and applied) print the blanket note as if none did.
  return ranked.every((issue) => {
    const target = issue.repoFullName.trim().toLowerCase();
    return !specRepos.some((repo) => repo.trim().toLowerCase() === target);
  });
}

/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export function rankCandidateIssues(
  candidates: RawCandidateIssue[],
  options: RankCandidateIssuesOptions = {},
): RankedCandidateIssue[] {
  const { normalized } = collectCandidates(candidates);
  return rankMetadataOpportunities(normalized, buildRankContext(options)) as RankedCandidateIssue[];
}

export function rankCandidateIssuesWithSummary(
  candidates: RawCandidateIssue[],
  options: RankCandidateIssuesOptions = {},
): RankedCandidateSummary {
  const { normalized, skippedInvalid } = collectCandidates(candidates);
  const ranked = rankMetadataOpportunities(normalized, buildRankContext(options)) as RankedCandidateIssue[];
  return {
    issues: ranked,
    skippedInvalid,
    usedDefaultGoalSpec: rankedUsesDefaultGoalSpec(ranked, options),
    defaultGoalSpec: DEFAULT_MINER_GOAL_SPEC,
  };
}
