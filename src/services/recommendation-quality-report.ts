import { listAgentRecommendationOutcomes } from "../db/repositories";
import type { AgentActionType, AgentRecommendationOutcomeRecord, AgentRecommendationOutcomeState, JsonValue, ProductUsageRole } from "../types";
import { nowIso } from "../utils/json";

export type RecommendationQualityRole = Extract<ProductUsageRole, "miner" | "maintainer" | "owner" | "operator">;

export type RecommendationQualityTotals = {
  total: number;
  positive: number;
  negative: number;
  positiveRate: number;
  maintainerLaneTotal: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
};

export type RecommendationQualityTrendBucket = RecommendationQualityTotals & {
  periodStart: string;
  periodEnd: string;
};

export type RecommendationQualityFailureCategory = {
  category: "closed_without_merge" | "stale" | "ignored" | "low_confidence" | "maintainer_lane";
  label: string;
  count: number;
  detail: string;
};

export type RecommendationQualityRoleSurface = RecommendationQualityTotals & {
  role: RecommendationQualityRole;
  label: string;
  topRepos: Array<{
    repoFullName: string;
    total: number;
    positive: number;
    negative: number;
    signal: "positive" | "negative" | "mixed";
  }>;
};

export type RecommendationQualityReport = {
  generatedAt: string;
  windowDays: number;
  visibility: "operator_only";
  empty: boolean;
  sparse: boolean;
  totals: RecommendationQualityTotals;
  trends: RecommendationQualityTrendBucket[];
  failureCategories: RecommendationQualityFailureCategory[];
  roleSurfaces: RecommendationQualityRoleSurface[];
  warnings: string[];
  publicExport: {
    available: false;
    reason: string;
  };
  privateSummary: string;
};

const ROLE_ORDER: RecommendationQualityRole[] = ["miner", "maintainer", "owner", "operator"];
const POSITIVE_STATES: AgentRecommendationOutcomeState[] = ["accepted", "merged", "improved"];
const NEGATIVE_STATES: AgentRecommendationOutcomeState[] = ["closed", "stale", "ignored"];

export async function buildRecommendationQualityReport(
  env: Env,
  options: { now?: string; windowDays?: number; limit?: number } = {},
): Promise<RecommendationQualityReport> {
  const generatedAt = options.now ?? nowIso();
  const windowDays = clampInteger(options.windowDays ?? 90, 1, 365);
  const outcomes = await listAgentRecommendationOutcomes(env, {
    windowDays,
    now: generatedAt,
    limit: options.limit ?? 5000,
  });
  return buildRecommendationQualityReportFromOutcomes(outcomes, { generatedAt, windowDays });
}

export function buildRecommendationQualityReportFromOutcomes(
  outcomes: AgentRecommendationOutcomeRecord[],
  options: { generatedAt: string; windowDays: number },
): RecommendationQualityReport {
  const sorted = [...outcomes].sort((left, right) => outcomeTimestamp(left).localeCompare(outcomeTimestamp(right)));
  const totals = qualityTotals(sorted);
  const roleSurfaces = ROLE_ORDER.map((role) => roleSurface(role, sorted.filter((outcome) => roleForOutcome(outcome) === role))).filter((surface) => surface.total > 0 || surface.maintainerLaneTotal > 0);
  const failureCategories = failureCategoryRows(sorted);
  const trends = trendBuckets(sorted, options.generatedAt, options.windowDays);
  const sparse = totals.total > 0 && totals.total < 5;
  const warnings = [
    ...(totals.total === 0 ? ["No recommendation outcomes have been evaluated in this window."] : []),
    ...(sparse ? ["Recommendation quality data is sparse; treat trends as directional only."] : []),
    ...(roleSurfaces.length === 0 ? ["No role-specific outcome surfaces have enough data to display."] : []),
  ];
  const privateSummary = totals.total === 0
    ? `No recommendation quality outcomes are available for the last ${options.windowDays} day(s).`
    : `Recommendation quality has ${totals.positive} positive and ${totals.negative} unresolved or negative outcome(s) across ${totals.total} evaluated recommendation(s).`;
  return {
    generatedAt: options.generatedAt,
    windowDays: options.windowDays,
    visibility: "operator_only",
    empty: totals.total === 0 && totals.maintainerLaneTotal === 0,
    sparse,
    totals,
    trends,
    failureCategories,
    roleSurfaces,
    warnings,
    publicExport: {
      available: false,
      reason: "Recommendation quality reports are available only in the authenticated operator dashboard.",
    },
    privateSummary,
  };
}

function roleSurface(role: RecommendationQualityRole, outcomes: AgentRecommendationOutcomeRecord[]): RecommendationQualityRoleSurface {
  const totals = qualityTotals(outcomes);
  const byRepo = new Map<string, AgentRecommendationOutcomeRecord[]>();
  for (const outcome of outcomes) {
    const repoFullName = outcome.outcomeRepoFullName ?? outcome.targetRepoFullName;
    if (!repoFullName) continue;
    const key = repoFullName.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), outcome]);
  }
  const topRepos = [...byRepo.values()]
    .map((repoOutcomes) => {
      const first = repoOutcomes[0]!;
      const repoTotals = qualityTotals(repoOutcomes);
      return {
        repoFullName: first.outcomeRepoFullName ?? first.targetRepoFullName ?? "unknown/repo",
        total: repoTotals.total,
        positive: repoTotals.positive,
        negative: repoTotals.negative,
        signal: signalFor(repoTotals),
      };
    })
    .sort((left, right) => right.total - left.total || left.repoFullName.localeCompare(right.repoFullName))
    .slice(0, 5);
  return {
    role,
    label: roleLabel(role),
    ...totals,
    topRepos,
  };
}

function qualityTotals(outcomes: AgentRecommendationOutcomeRecord[]): RecommendationQualityTotals {
  const positive = outcomes.filter((outcome) => POSITIVE_STATES.includes(outcome.outcomeState)).length;
  const negative = outcomes.filter((outcome) => NEGATIVE_STATES.includes(outcome.outcomeState)).length;
  const total = positive + negative;
  return {
    total,
    positive,
    negative,
    positiveRate: total > 0 ? roundRate(positive / total) : 0,
    maintainerLaneTotal: outcomes.filter((outcome) => outcome.maintainerLane).length,
    highConfidence: outcomes.filter((outcome) => outcome.confidence === "high").length,
    mediumConfidence: outcomes.filter((outcome) => outcome.confidence === "medium").length,
    lowConfidence: outcomes.filter((outcome) => outcome.confidence === "low").length,
  };
}

function failureCategoryRows(outcomes: AgentRecommendationOutcomeRecord[]): RecommendationQualityFailureCategory[] {
  const rows: RecommendationQualityFailureCategory[] = [
    {
      category: "closed_without_merge",
      label: "Closed without merge",
      count: outcomes.filter((outcome) => outcome.outcomeState === "closed").length,
      detail: "Recommended work reached a closed terminal state without a merge signal.",
    },
    {
      category: "stale",
      label: "Stale follow-through",
      count: outcomes.filter((outcome) => outcome.outcomeState === "stale").length,
      detail: "Recommended work remained open without fresh cached activity past the freshness window.",
    },
    {
      category: "ignored",
      label: "No matched activity",
      count: outcomes.filter((outcome) => outcome.outcomeState === "ignored").length,
      detail: "No cached PR or issue activity matched the recommendation after the action window.",
    },
    {
      category: "low_confidence",
      label: "Low confidence matches",
      count: outcomes.filter((outcome) => outcome.confidence === "low").length,
      detail: "The recommendation target was too broad or missing for a strong match.",
    },
    {
      category: "maintainer_lane",
      label: "Maintainer-lane separated",
      count: outcomes.filter((outcome) => outcome.maintainerLane).length,
      detail: "Maintainer-associated outcomes are separated from contributor recommendation quality.",
    },
  ];
  return rows.filter((row) => row.count > 0).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function trendBuckets(
  outcomes: AgentRecommendationOutcomeRecord[],
  generatedAt: string,
  windowDays: number,
): RecommendationQualityTrendBucket[] {
  const bucketCount = Math.min(6, Math.max(1, Math.ceil(windowDays / 7)));
  const now = Date.parse(generatedAt);
  const bucketMs = Math.max(1, Math.ceil((windowDays * 24 * 60 * 60 * 1000) / bucketCount));
  return Array.from({ length: bucketCount }, (_, index) => {
    const periodStartMs = now - bucketMs * (bucketCount - index);
    const periodEndMs = index === bucketCount - 1 ? now : periodStartMs + bucketMs;
    const bucketOutcomes = outcomes.filter((outcome) => {
      const timestamp = Date.parse(outcomeTimestamp(outcome));
      return Number.isFinite(timestamp) && timestamp >= periodStartMs && timestamp <= periodEndMs;
    });
    return {
      periodStart: new Date(periodStartMs).toISOString(),
      periodEnd: new Date(periodEndMs).toISOString(),
      ...qualityTotals(bucketOutcomes),
    };
  });
}

function roleForOutcome(outcome: AgentRecommendationOutcomeRecord): RecommendationQualityRole {
  const metadataRole = roleFromMetadata(outcome.metadata);
  if (metadataRole) return metadataRole;
  if (outcome.maintainerLane) return "maintainer";
  return roleFromActionType(outcome.actionType);
}

function roleFromMetadata(metadata: Record<string, JsonValue>): RecommendationQualityRole | null {
  for (const key of ["role", "roles", "actorRole", "actorKind", "audience", "surface"]) {
    const role = roleFromJsonValue(metadata[key]);
    if (role) return role;
  }
  return null;
}

function roleFromJsonValue(value: JsonValue | undefined): RecommendationQualityRole | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const role = roleFromJsonValue(entry);
      if (role) return role;
    }
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replace(/[_\s-]+/g, "_");
  if (normalized === "miner" || normalized === "contributor") return "miner";
  if (normalized === "maintainer") return "maintainer";
  if (normalized === "owner" || normalized === "repo_owner" || normalized === "repository_owner") return "owner";
  if (normalized === "operator") return "operator";
  return null;
}

function roleFromActionType(actionType: AgentActionType): RecommendationQualityRole {
  if (actionType === "explain_repo_fit") return "owner";
  if (actionType === "monitor_existing_pr" || actionType === "check_duplicate_risk") return "maintainer";
  return "miner";
}

function roleLabel(role: RecommendationQualityRole): string {
  if (role === "miner") return "Miner guidance";
  if (role === "maintainer") return "Maintainer guidance";
  if (role === "owner") return "Repo-owner guidance";
  return "Operator guidance";
}

function signalFor(totals: RecommendationQualityTotals): "positive" | "negative" | "mixed" {
  if (totals.positive > totals.negative) return "positive";
  if (totals.negative > totals.positive) return "negative";
  return "mixed";
}

function outcomeTimestamp(outcome: AgentRecommendationOutcomeRecord): string {
  return outcome.updatedAt ?? outcome.detectedAt ?? outcome.createdAt ?? "";
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
