import { computeMinerGoalLaneFit } from "./miner-goal-lane-fit.js";
import { DEFAULT_MINER_GOAL_SPEC, type MinerGoalSpec } from "./miner-goal-spec.js";
import { computeOpportunityCompetition } from "./opportunity-competition.js";
import { computeOpportunityFreshness } from "./opportunity-freshness.js";
import {
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";

/** Metadata-only candidate issue shape produced by `@jsonbored/gittensory-miner` fan-out helpers. */
export type MetadataCandidateIssue = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: readonly string[];
  commentsCount: number;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
};

export type MetadataRankContext = {
  nowMs: number;
  highRiskDuplicateClusters?: number | undefined;
  openPullRequests?: number | undefined;
  goalSpecsByRepo?: Readonly<Record<string, MinerGoalSpec>> | undefined;
};

const POSITIVE_LABELS = Object.freeze([
  "good first issue",
  "help wanted",
  "enhancement",
  "feature",
  "documentation",
]);
const NEGATIVE_LABELS = Object.freeze([
  "blocked",
  "wontfix",
  "duplicate",
  "invalid",
  "question",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeLabels(labels: readonly string[]): string[] {
  return labels
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveGoalSpec(repoFullName: string, context: MetadataRankContext): MinerGoalSpec {
  const target = repoFullName.trim().toLowerCase();
  const entries = context.goalSpecsByRepo ? Object.entries(context.goalSpecsByRepo) : [];
  for (const [repo, spec] of entries) {
    if (repo.trim().toLowerCase() === target) return spec;
  }
  return DEFAULT_MINER_GOAL_SPEC;
}

function issueAgeDays(issue: MetadataCandidateIssue, nowMs: number): number {
  const stamp =
    (typeof issue.updatedAt === "string" && issue.updatedAt.trim()) ||
    (typeof issue.createdAt === "string" && issue.createdAt.trim()) ||
    "";
  if (!stamp) return 0;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000));
}

/**
 * Estimate reward potential from issue labels alone. Explicitly negative labels collapse the score; common
 * contribution labels raise it; everything else keeps a neutral baseline.
 */
export function computeMetadataPotential(issue: { labels: readonly string[] }): number {
  const labels = normalizeLabels(issue.labels);
  if (labels.some((label) => NEGATIVE_LABELS.includes(label))) return 0;
  let score = 0.45;
  if (labels.some((label) => POSITIVE_LABELS.includes(label))) score += 0.35;
  if (labels.includes("bug")) score += 0.1;
  if (labels.includes("refactor")) score += 0.05;
  return clamp01(score);
}

/**
 * Estimate achievability from metadata-only cues: lower discussion load and fresher issues score higher.
 */
export function computeMetadataFeasibility(issue: MetadataCandidateIssue, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return 0;
  const comments = finiteNonNegativeInt(issue.commentsCount);
  const commentScore = clamp01(1 - comments / 25);
  const ageDays = issueAgeDays(issue, nowMs);
  const ageScore = clamp01(Math.exp(-ageDays / 45));
  const titleLength = normalizeTitle(issue.title).length;
  const titleScore = titleLength >= 8 ? 1 : titleLength >= 4 ? 0.7 : 0.4;
  return clamp01(commentScore * 0.45 + ageScore * 0.35 + titleScore * 0.2);
}

function titlesOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return longer.includes(shorter) && shorter.length >= 12;
}

/**
 * Estimate duplicate-work risk inside a metadata-only candidate batch by looking for overlapping titles in the
 * same repository. This is intentionally conservative: any strong overlap raises dupRisk toward 1.
 */
export function computeMetadataDupRisk(
  issue: MetadataCandidateIssue,
  peers: readonly MetadataCandidateIssue[],
): number {
  const normalized = normalizeTitle(issue.title);
  if (!normalized) return 1;
  let overlaps = 0;
  for (const peer of peers) {
    if (peer.issueNumber === issue.issueNumber && peer.repoFullName === issue.repoFullName) continue;
    if (peer.repoFullName.trim().toLowerCase() !== issue.repoFullName.trim().toLowerCase()) continue;
    if (titlesOverlap(normalized, normalizeTitle(peer.title))) overlaps += 1;
  }
  if (overlaps === 0) return 0;
  return clamp01(overlaps / (overlaps + 1));
}

/** Build the five ranker inputs for one metadata candidate. Pure. */
export function buildMetadataRankInput(
  issue: MetadataCandidateIssue,
  peers: readonly MetadataCandidateIssue[],
  context: MetadataRankContext,
): OpportunityRankInput {
  const goalSpec = resolveGoalSpec(issue.repoFullName, context);
  const repoCompetition = computeOpportunityCompetition(
    context.highRiskDuplicateClusters ?? 0,
    context.openPullRequests ?? 0,
  );
  const batchDupRisk = computeMetadataDupRisk(issue, peers);
  return {
    potential: computeMetadataPotential(issue),
    feasibility: computeMetadataFeasibility(issue, context.nowMs),
    laneFit: computeMinerGoalLaneFit(issue, goalSpec),
    freshness: computeOpportunityFreshness(
      [{ state: "open", updatedAt: issue.updatedAt ?? null, createdAt: issue.createdAt ?? null }],
      context.nowMs,
    ),
    dupRisk: clamp01(Math.max(batchDupRisk, repoCompetition)),
  };
}

/** Rank metadata-only candidates with the shared opportunity ranker. Pure. */
export function rankMetadataOpportunities<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  const annotated = candidates.map((candidate) => ({
    ...candidate,
    ...buildMetadataRankInput(candidate, candidates, context),
  }));
  return rankOpportunities(annotated);
}
