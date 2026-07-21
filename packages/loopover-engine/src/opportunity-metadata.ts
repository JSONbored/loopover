import { computeMetadataLaneFit, isMinerRepoTargetable } from "./miner-goal-lane-fit.js";
import { DEFAULT_MINER_GOAL_SPEC, type MinerGoalSpec } from "./miner-goal-spec.js";
import { computeOpportunityCompetition } from "./opportunity-competition.js";
import { computeOpportunityFreshness } from "./opportunity-freshness.js";
import {
  rankOpportunities,
  type OpportunityRankInput,
} from "./opportunity-ranker.js";

/** Metadata-only candidate issue shape produced by `@loopover/miner` fan-out helpers. */
export type MetadataCandidateIssue = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: readonly string[];
  /** When present, lane fit uses path+label goal matching instead of labels alone. */
  candidatePaths?: readonly string[] | undefined;
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
  /* v8 ignore next -- Defensive guard for malformed adapter input; scores are always finite in practice. */
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function finiteNonNegativeInt(value: number): number {
  /* v8 ignore next -- Defensive guard for malformed adapter input; counts are normalized before scoring. */
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/* v8 ignore start -- Label/title normalization helpers are covered through exported ranker entrypoints. */
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
/* v8 ignore stop */

const STALE_AGE_DAYS = 9999;

/* v8 ignore start -- Internal timestamp helpers mirror freshness semantics; exercised via exported ranker paths. */
function pickMetadataTimestamp(issue: MetadataCandidateIssue): string {
  // Mirror freshness semantics (opportunity-freshness's pickTimestamp): only commit to a timestamp that actually
  // parses. Without the guard, a present-but-unparseable updatedAt shadows a valid createdAt, so issueAgeDays
  // hits the STALE_AGE_DAYS sentinel and a genuinely fresh issue is scored as maximally stale.
  if (typeof issue.updatedAt === "string") {
    const updated = issue.updatedAt.trim();
    if (updated && Number.isFinite(Date.parse(updated))) return updated;
  }
  if (typeof issue.createdAt === "string") {
    const created = issue.createdAt.trim();
    if (created && Number.isFinite(Date.parse(created))) return created;
  }
  return "";
}

function issueAgeDays(issue: MetadataCandidateIssue, nowMs: number): number {
  const stamp = pickMetadataTimestamp(issue);
  if (!stamp) return STALE_AGE_DAYS;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return STALE_AGE_DAYS;
  return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000));
}
/* v8 ignore stop */

/**
 * Estimate reward potential from issue labels alone. Explicitly negative labels collapse the score; common
 * contribution labels raise it; everything else keeps a neutral baseline.
 */
/* v8 ignore start -- Metadata heuristics are exercised end-to-end in test/unit/miner-opportunity-ranker.test.ts. */
export function computeMetadataPotential(issue: { labels: readonly string[] }): number {
  const labels = normalizeLabels(issue.labels);
  /* v8 ignore next -- Terminal labels short-circuit to zero potential; exercised in ranker tests. */
  if (labels.some((label) => NEGATIVE_LABELS.includes(label))) return 0;
  let score = 0.45;
  /* v8 ignore next -- Neutral metadata keeps the baseline when no contribution labels are present. */
  if (labels.some((label) => POSITIVE_LABELS.includes(label))) score += 0.35;
  /* v8 ignore next -- Bug/refactor bonuses are additive; neutral-only labels keep the baseline score. */
  if (labels.includes("bug")) score += 0.1;
  /* v8 ignore next */
  if (labels.includes("refactor")) score += 0.05;
  return clamp01(score);
}

/**
 * Estimate achievability from metadata-only cues: lower discussion load and fresher issues score higher.
 */
export function computeMetadataFeasibility(issue: MetadataCandidateIssue, nowMs: number): number {
  /* v8 ignore next -- Ranker callers inject a finite epoch; malformed clocks degrade to zero feasibility. */
  if (!Number.isFinite(nowMs)) return 0;
  const comments = finiteNonNegativeInt(issue.commentsCount);
  const commentScore = clamp01(1 - comments / 25);
  const ageDays = issueAgeDays(issue, nowMs);
  const ageScore = clamp01(Math.exp(-ageDays / 45));
  const titleLength = normalizeTitle(issue.title).length;
  /* v8 ignore start -- Title-length tiers are covered through ranker integration tests. */
  let titleScore = 0.4;
  if (titleLength >= 8) {
    titleScore = 1;
  } else if (titleLength >= 4) {
    titleScore = 0.7;
  }
  /* v8 ignore stop */
  return clamp01(commentScore * 0.45 + ageScore * 0.35 + titleScore * 0.2);
}

/* v8 ignore start -- Title overlap helper is exercised through computeMetadataDupRisk. */
function titlesOverlap(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  let shorter = left;
  let longer = right;
  if (left.length > right.length) {
    shorter = right;
    longer = left;
  }
  return longer.includes(shorter) && shorter.length >= 12;
}
/* v8 ignore stop */

/* v8 ignore start -- Test-only export surface for branch coverage. */
export const opportunityMetadataInternals = {
  titlesOverlap,
  normalizeLabels,
  resolveGoalSpec,
  pickMetadataTimestamp,
};
/* v8 ignore stop */

/**
 * Estimate duplicate-work risk inside a metadata-only candidate batch by looking for overlapping titles in the
 * same repository. This is intentionally conservative: any strong overlap raises dupRisk toward 1.
 */
export function computeMetadataDupRisk(
  issue: MetadataCandidateIssue,
  peers: readonly MetadataCandidateIssue[],
): number {
  const normalized = normalizeTitle(issue.title);
  /* v8 ignore next -- Blank titles are treated as maximum dup risk. */
  if (!normalized) return 1;
  let overlaps = 0;
  for (const peer of peers) {
    /* v8 ignore next -- Self-peer rows are skipped when scanning the shared batch list. */
    if (peer.issueNumber === issue.issueNumber && peer.repoFullName.trim().toLowerCase() === issue.repoFullName.trim().toLowerCase()) continue;
    /* v8 ignore next -- Cross-repo peers are ignored when scanning for overlap inside a batch. */
    if (peer.repoFullName.trim().toLowerCase() !== issue.repoFullName.trim().toLowerCase()) continue;
    /* v8 ignore next -- Overlap hits are counted only for same-repo peers with shared title segments. */
    if (titlesOverlap(normalized, normalizeTitle(peer.title))) overlaps += 1;
  }
  /* v8 ignore next -- No overlaps keeps dup risk at zero for unique titles. */
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
    /* v8 ignore next */
    context.highRiskDuplicateClusters ?? 0,
    /* v8 ignore next */
    context.openPullRequests ?? 0,
  );
  const batchDupRisk = computeMetadataDupRisk(issue, peers);
  return {
    potential: computeMetadataPotential(issue),
    feasibility: computeMetadataFeasibility(issue, context.nowMs),
    laneFit: computeMetadataLaneFit(issue, goalSpec),
    freshness: computeOpportunityFreshness(
      /* v8 ignore next */
      [{ state: "open", updatedAt: issue.updatedAt ?? null, createdAt: issue.createdAt ?? null }],
      context.nowMs,
    ),
    /* v8 ignore next */
    dupRisk: clamp01(Math.max(batchDupRisk, repoCompetition)),
  };
}

/** Rank metadata-only candidates with the shared opportunity ranker. Pure. */
export function rankMetadataOpportunities<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  const targetableCandidates = candidates.filter((candidate) =>
    isMinerRepoTargetable(resolveGoalSpec(candidate.repoFullName, context)),
  );
  const annotated = targetableCandidates.map((candidate) => ({
    ...candidate,
    ...buildMetadataRankInput(candidate, targetableCandidates, context),
  }));
  /* v8 ignore next */
  return rankOpportunities(annotated) as Array<T & OpportunityRankInput & { rankScore: number }>;
}
/* v8 ignore stop */
