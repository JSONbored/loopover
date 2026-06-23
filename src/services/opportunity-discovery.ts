import { listIssueWatchSubscriptionsForLogin } from "../db/repositories";
import type { ParticipationLane, ContributorOpportunity } from "../signals/engine";
import type { DetectedNotificationEvent, IssueRecord, IssueWatchSubscription } from "../types";
import type { ContributorDecisionPack } from "./decision-pack";
import { nowIso } from "../utils/json";

const PRIORITIZED_ALERT_MAX_RANK = 3;
const AGING_ALERT_MIN_DAYS = 14;

export type OpportunityDiscoveryFilters = {
  lanes?: ParticipationLane[] | undefined;
  labels?: string[] | undefined;
  freshnessDays?: number | undefined;
  limit?: number | undefined;
};

export type OpportunityDiscoveryItem = {
  rank: number;
  repoFullName: string;
  issueNumber: number;
  title: string;
  lane: ParticipationLane;
  fit: ContributorOpportunity["fit"];
  availability: ContributorOpportunity["availability"];
  multiplierTier: ContributorOpportunity["multiplierTier"];
  priorityBand: "top" | "high" | "watch";
  freshness: {
    ageDays: number;
    band: "new" | "fresh" | "recent" | "stale";
  };
  labels: string[];
  whyNow: string[];
  cautions: string[];
};

export type OpportunityDiscoveryResult = {
  login: string;
  generatedAt: string;
  freshness: ContributorDecisionPack["freshness"];
  summary: string;
  filters: {
    lanes: ParticipationLane[];
    labels: string[];
    freshnessDays?: number | undefined;
    limit: number;
  };
  opportunities: OpportunityDiscoveryItem[];
};

type DecoratedOpportunity = {
  opportunity: ContributorOpportunity;
  issue: IssueRecord;
  rank: number;
  ageDays: number;
};

function issueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName.toLowerCase()}#${issueNumber}`;
}

function normalizeLabels(labels?: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((label) => label.toLowerCase().trim()).filter(Boolean))];
}

function normalizeLanes(lanes?: ParticipationLane[] | undefined): ParticipationLane[] {
  return [...new Set((lanes ?? []).map((lane) => lane.trim().toLowerCase() as ParticipationLane).filter(Boolean))];
}

function issueAgeDays(issue: IssueRecord): number {
  const raw = issue.createdAt ?? issue.updatedAt;
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed) / 86_400_000));
}

function freshnessBand(ageDays: number): OpportunityDiscoveryItem["freshness"]["band"] {
  if (ageDays <= 3) return "new";
  if (ageDays <= 14) return "fresh";
  if (ageDays <= 45) return "recent";
  return "stale";
}

function priorityBand(rank: number): OpportunityDiscoveryItem["priorityBand"] {
  if (rank <= 3) return "top";
  if (rank <= 10) return "high";
  return "watch";
}

function decoratePackOpportunities(pack: ContributorDecisionPack, issues: IssueRecord[]): DecoratedOpportunity[] {
  const issuesByKey = new Map(issues.map((issue) => [issueKey(issue.repoFullName, issue.number), issue] as const));
  return pack.opportunities
    .map((opportunity, index) => {
      if (typeof opportunity.issueNumber !== "number") return null;
      const issue = issuesByKey.get(issueKey(opportunity.repoFullName, opportunity.issueNumber));
      if (!issue) return null;
      return {
        opportunity,
        issue,
        rank: index + 1,
        ageDays: issueAgeDays(issue),
      };
    })
    .filter((entry): entry is DecoratedOpportunity => entry !== null);
}

function matchesSubscription(entry: DecoratedOpportunity, subscription: IssueWatchSubscription): boolean {
  const watchedLabels = new Set(subscription.labels);
  const issueLabels = new Set(entry.issue.labels.map((label) => label.toLowerCase().trim()));
  if (subscription.lanes.length > 0 && !subscription.lanes.includes(entry.opportunity.lane)) return false;
  if (subscription.freshnessDays && entry.ageDays > subscription.freshnessDays) return false;
  if (watchedLabels.size > 0 && !subscription.labels.some((label) => issueLabels.has(label))) return false;
  return true;
}

function matchesFilters(entry: DecoratedOpportunity, filters: OpportunityDiscoveryFilters): boolean {
  const lanes = normalizeLanes(filters.lanes);
  const labels = normalizeLabels(filters.labels);
  const issueLabels = new Set(entry.issue.labels.map((label) => label.toLowerCase().trim()));
  if (lanes.length > 0 && !lanes.includes(entry.opportunity.lane)) return false;
  if (typeof filters.freshnessDays === "number" && entry.ageDays > filters.freshnessDays) return false;
  if (labels.length > 0 && !labels.some((label) => issueLabels.has(label))) return false;
  return true;
}

export function buildOpportunityDiscoveryResult(
  pack: ContributorDecisionPack,
  issues: IssueRecord[],
  filters: OpportunityDiscoveryFilters = {},
): OpportunityDiscoveryResult {
  const limit = Math.min(25, Math.max(1, filters.limit ?? 10));
  const lanes = normalizeLanes(filters.lanes);
  const labels = normalizeLabels(filters.labels);
  const decorated = decoratePackOpportunities(pack, issues).filter((entry) => matchesFilters(entry, filters)).slice(0, limit);
  const opportunities = decorated.map((entry) => ({
    rank: entry.rank,
    repoFullName: entry.opportunity.repoFullName,
    issueNumber: entry.issue.number,
    title: entry.opportunity.title,
    lane: entry.opportunity.lane,
    fit: entry.opportunity.fit,
    availability: entry.opportunity.availability,
    multiplierTier: entry.opportunity.multiplierTier,
    priorityBand: priorityBand(entry.rank),
    freshness: { ageDays: entry.ageDays, band: freshnessBand(entry.ageDays) },
    labels: entry.issue.labels,
    whyNow: entry.opportunity.reasons.slice(0, 4),
    cautions: entry.opportunity.warnings.slice(0, 4),
  }));
  return {
    login: pack.login,
    generatedAt: pack.generatedAt,
    freshness: pack.freshness,
    summary: opportunities.length > 0
      ? `${pack.login} has ${opportunities.length} ranked cross-repo issue candidate(s) ready to inspect now.`
      : `${pack.login} has no ranked cross-repo issue candidates matching the current filters.`,
    filters: {
      lanes,
      labels,
      ...(typeof filters.freshnessDays === "number" ? { freshnessDays: filters.freshnessDays } : {}),
      limit,
    },
    opportunities,
  };
}

export async function detectDecisionPackOpportunityEvents(
  env: Env,
  pack: ContributorDecisionPack,
  issues: IssueRecord[],
): Promise<DetectedNotificationEvent[]> {
  const subscriptions = await listIssueWatchSubscriptionsForLogin(env, pack.login);
  if (subscriptions.length === 0) return [];
  const decorated = decoratePackOpportunities(pack, issues);
  const events = new Map<string, DetectedNotificationEvent>();
  for (const subscription of subscriptions) {
    const matches = decorated.filter((entry) => entry.opportunity.fit === "good" && entry.opportunity.availability === "ready" && matchesSubscription(entry, subscription));
    const top = matches[0];
    if (!top) continue;
    const trigger =
      top.rank <= PRIORITIZED_ALERT_MAX_RANK
        ? "reprioritized"
        : top.ageDays >= AGING_ALERT_MIN_DAYS
          ? "aging"
          : null;
    if (!trigger) continue;
    const dedupKey = `issue_watch_match:${trigger}:${top.opportunity.repoFullName}#${top.issue.number}:${pack.login.toLowerCase()}`;
    events.set(dedupKey, {
      eventType: "issue_watch_match",
      trigger,
      recipientLogin: pack.login,
      repoFullName: top.opportunity.repoFullName,
      pullNumber: top.issue.number,
      dedupKey,
      deeplink: `https://github.com/${top.opportunity.repoFullName}/issues/${top.issue.number}`,
      actorLogin: top.issue.authorLogin ?? "unknown",
      detectedAt: nowIso(),
    });
  }
  return [...events.values()];
}
