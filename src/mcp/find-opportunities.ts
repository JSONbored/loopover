// Hosted `gittensory_find_opportunities` (#2308): metadata-only cross-repo discovery that composes the
// opportunity fan-out (#2307), deterministic ranker (#2302), and goal-model signals from
// `@jsonbored/gittensory-engine` — never clones source, never uploads metadata, never writes to GitHub.
// Banned repos are hard-skipped upstream in fan-out AI-policy resolution; only `aiPolicyAllowed: true`
// rows are ever returned.

import {
  DEFAULT_MINER_GOAL_SPEC,
  type MinerGoalSpec,
} from "../../packages/gittensory-engine/src/miner-goal-spec.js";
import {
  fetchCandidateIssuesWithSummary,
  searchCandidateIssuesWithSummary,
} from "../../packages/gittensory-miner/lib/opportunity-fanout.js";
import { rankCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-ranker.js";
import { createInstallationToken } from "../github/app";
import { getRepository } from "../db/repositories";

export type FindOpportunitiesTarget = { owner: string; repo: string };

export type FindOpportunitiesGoalSpec = {
  lane?: string | undefined;
  minRankScore?: number | undefined;
  languages?: string[] | undefined;
};

export type FindOpportunitiesInput = {
  targets?: FindOpportunitiesTarget[] | undefined;
  searchQuery?: string | undefined;
  goalSpec?: FindOpportunitiesGoalSpec | undefined;
  limit?: number | undefined;
};

export type FindOpportunitiesRankedEntry = {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  rankScore: number;
  laneFit: number;
  freshness: number;
  dupRisk: number;
  aiPolicyAllowed: true;
};

export type FindOpportunitiesResult = {
  status: "ok" | "invalid_request" | "github_token_unavailable";
  ranked: FindOpportunitiesRankedEntry[];
  totalCandidates: number;
  appliedLane?: string | undefined;
  appliedMinRankScore?: number | undefined;
  reason?: string | undefined;
  warnings?: Array<{ repoFullName: string; stage: string; message: string }> | undefined;
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Public-safe 0–100 rank score derived from the ranker's 0–1 product score. */
export function publicRankScore(rankScore: number): number {
  return Math.round(clamp01(rankScore) * 100);
}

export function normalizeFindOpportunitiesLimit(limit: number | null | undefined): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit!)));
}

export function validateFindOpportunitiesInput(
  input: FindOpportunitiesInput,
): { ok: true; value: FindOpportunitiesInput } | { ok: false; reason: string } {
  const targets = Array.isArray(input.targets) ? input.targets : undefined;
  const searchQuery = typeof input.searchQuery === "string" ? input.searchQuery.trim() : "";
  const hasTargets = Boolean(targets && targets.length > 0);
  const hasSearch = searchQuery.length > 0;
  if (!hasTargets && !hasSearch) {
    return { ok: false, reason: "targets_or_search_query_required" };
  }
  if (hasTargets) {
    for (const target of targets!) {
      const owner = typeof target?.owner === "string" ? target.owner.trim() : "";
      const repo = typeof target?.repo === "string" ? target.repo.trim() : "";
      if (!owner || !repo) return { ok: false, reason: "invalid_target" };
    }
  }
  if (hasSearch && searchQuery.length > 500) return { ok: false, reason: "search_query_too_long" };
  const minRankScore = input.goalSpec?.minRankScore;
  if (minRankScore !== undefined && (!Number.isFinite(minRankScore) || minRankScore < 0 || minRankScore > 100)) {
    return { ok: false, reason: "invalid_min_rank_score" };
  }
  return {
    ok: true,
    value: {
      ...(hasTargets ? { targets } : {}),
      ...(hasSearch ? { searchQuery } : {}),
      ...(input.goalSpec ? { goalSpec: input.goalSpec } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
  };
}

function buildGoalSpecsByRepo(
  repoFullNames: readonly string[],
  goalSpec: FindOpportunitiesGoalSpec | undefined,
): Record<string, MinerGoalSpec> | undefined {
  const lane = typeof goalSpec?.lane === "string" ? goalSpec.lane.trim() : "";
  const languages = Array.isArray(goalSpec?.languages)
    ? goalSpec.languages.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (!lane && languages.length === 0) return undefined;
  const spec: MinerGoalSpec = {
    ...DEFAULT_MINER_GOAL_SPEC,
    ...(lane ? { preferredLabels: [lane] } : {}),
    ...(languages.length > 0
      ? { wantedPaths: languages.map((language) => `**/*.${language.trim().toLowerCase()}`) }
      : {}),
  };
  const out: Record<string, MinerGoalSpec> = {};
  for (const repoFullName of repoFullNames) out[repoFullName] = spec;
  return out;
}

function toRankedEntry(
  issue: {
    owner: string;
    repo: string;
    issueNumber: number;
    title: string;
    rankScore: number;
    laneFit: number;
    freshness: number;
    dupRisk: number;
  },
): FindOpportunitiesRankedEntry {
  return {
    owner: issue.owner,
    repo: issue.repo,
    issueNumber: issue.issueNumber,
    title: issue.title,
    rankScore: publicRankScore(issue.rankScore),
    laneFit: clamp01(issue.laneFit),
    freshness: clamp01(issue.freshness),
    dupRisk: clamp01(issue.dupRisk),
    aiPolicyAllowed: true,
  };
}

async function resolveDiscoveryGithubToken(
  env: Env,
  targets: readonly FindOpportunitiesTarget[],
): Promise<string | null> {
  if (env.GITHUB_PUBLIC_TOKEN) return env.GITHUB_PUBLIC_TOKEN;
  for (const target of targets) {
    const fullName = `${target.owner}/${target.repo}`;
    const repo = await getRepository(env, fullName);
    const installationId = repo?.installationId;
    if (!installationId) continue;
    try {
      return await createInstallationToken(env, installationId);
    } catch {
      continue;
    }
  }
  return null;
}

export async function runFindOpportunities(
  env: Env,
  input: FindOpportunitiesInput,
  options: {
    canAccessRepo?: ((repoFullName: string) => Promise<boolean> | boolean) | undefined;
  } = {},
): Promise<FindOpportunitiesResult> {
  const validated = validateFindOpportunitiesInput(input);
  if (!validated.ok) {
    return { status: "invalid_request", ranked: [], totalCandidates: 0, reason: validated.reason };
  }
  const parsed = validated.value;
  const limit = normalizeFindOpportunitiesLimit(parsed.limit);
  const minRankScore = parsed.goalSpec?.minRankScore ?? 0;
  const appliedLane = parsed.goalSpec?.lane?.trim() || undefined;

  const targets = parsed.targets ?? [];
  const token = await resolveDiscoveryGithubToken(env, targets);
  if (!token && targets.length > 0) {
    const anyInstalled = await Promise.all(
      targets.map(async (target) => Boolean(await getRepository(env, `${target.owner}/${target.repo}`))),
    );
    if (!anyInstalled.some(Boolean)) {
      return {
        status: "github_token_unavailable",
        ranked: [],
        totalCandidates: 0,
        reason: "github_token_unavailable",
      };
    }
  }

  let issues: Awaited<ReturnType<typeof fetchCandidateIssuesWithSummary>>["issues"] = [];
  let warnings: Array<{ repoFullName: string; stage: string; message: string }> = [];
  if (parsed.searchQuery) {
    const search = await searchCandidateIssuesWithSummary(parsed.searchQuery, token ?? "", {});
    issues = search.issues;
    warnings = search.warnings;
  } else {
    const allowedTargets: FindOpportunitiesTarget[] = [];
    for (const target of targets) {
      const fullName = `${target.owner}/${target.repo}`;
      if (options.canAccessRepo && !(await options.canAccessRepo(fullName))) continue;
      allowedTargets.push(target);
    }
    if (allowedTargets.length === 0) {
      return { status: "invalid_request", ranked: [], totalCandidates: 0, reason: "no_accessible_targets" };
    }
    const fetched = await fetchCandidateIssuesWithSummary(allowedTargets, token ?? "", {});
    issues = fetched.issues;
    warnings = fetched.warnings;
  }

  if (parsed.searchQuery && options.canAccessRepo) {
    const filtered = [];
    for (const issue of issues) {
      if (await options.canAccessRepo(issue.repoFullName)) filtered.push(issue);
    }
    issues = filtered;
  }

  const repoFullNames = [...new Set(issues.map((issue) => issue.repoFullName))];
  const ranked = rankCandidateIssuesWithSummary(issues, {
    goalSpecsByRepo: buildGoalSpecsByRepo(repoFullNames, parsed.goalSpec),
  });
  const filtered = ranked.issues
    .map(toRankedEntry)
    .filter((entry) => entry.rankScore >= minRankScore)
    .slice(0, limit);

  return {
    status: "ok",
    ranked: filtered,
    totalCandidates: ranked.issues.length,
    ...(appliedLane ? { appliedLane } : {}),
    ...(minRankScore > 0 ? { appliedMinRankScore: minRankScore } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
