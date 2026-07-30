/**
 * Package-local `buildIssueQualityReport` (#6057).
 *
 * Canonical scoring lives in the host signals engine (`signals/engine.ts`), which is intentionally
 * excluded from this package's `tsc` emit (host-bound imports). Re-exporting that file from the public
 * barrel breaks `npm run build` inside `@loopover/engine` — see closed #6139.
 *
 * This module is the portable twin of that function, matching the same call signature and status rules,
 * built only on package-local types/helpers the way `buildCollisionReport` already is.
 */

import type {
  BountyLifecycle,
  BountyRecord,
  CollisionCluster,
  CollisionReport,
  IssueQualityReport,
  IssueRecord,
  LaneAdvice,
  PullRequestRecord,
  RecentMergedPullRequestRecord,
  RepositoryRecord,
} from "../types/predicted-gate-types.js";
import { nowIso } from "../utils/json.js";
import { isMaintainerAuthorAssociation } from "../settings/author-association.js";
import {
  bountyIssueKey,
  buildCollisionReport,
  buildLaneAdvice,
  classifyBountyLifecycle,
  indexBountiesByIssue,
} from "./predicted-gate-engine.js";

const ISSUE_QUALITY_REPORT_CAP = 100;
const ISSUE_DISCOVERY_LIFECYCLE_REPORT_CAP = 300;

const MAINTAINER_WIP_LABELS = new Set([
  "wip",
  "work in progress",
  "work-in-progress",
  "in progress",
  "in-progress",
  "blocked",
  "on hold",
  "on-hold",
  "draft",
  "do not work",
  "do-not-work",
  "internal",
]);

type IssueDiscoveryLifecycleState =
  | "open"
  | "closed_not_solved"
  | "solved"
  | "valid_solved"
  | "stale"
  | "duplicate"
  | "invalid";

type LifecycleEntry = {
  number: number;
  title: string;
  state: IssueDiscoveryLifecycleState;
  solvedByPullRequests: number[];
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  /* v8 ignore next -- Invalid timestamps normalize to fresh. */
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function isMaintainerWipIssue(issue: IssueRecord): boolean {
  return isMaintainerAuthorAssociation(issue.authorAssociation) && issue.labels.some((label) => MAINTAINER_WIP_LABELS.has(label.toLowerCase().trim()));
}

function indexPullRequestsByLinkedIssue<T extends { number: number; linkedIssues: number[] }>(pullRequests: T[]): Map<number, T[]> {
  const byIssue = new Map<number, T[]>();
  for (const pr of pullRequests) {
    for (const issueNumber of new Set(pr.linkedIssues)) {
      const bucket = byIssue.get(issueNumber);
      if (bucket) bucket.push(pr);
      else byIssue.set(issueNumber, [pr]);
    }
  }
  return byIssue;
}

function indexCollisionClustersByIssue(clusters: CollisionCluster[]): Map<number, CollisionCluster[]> {
  const byIssue = new Map<number, CollisionCluster[]>();
  for (const cluster of clusters) {
    const issueNumbers = new Set<number>();
    for (const item of cluster.items) if (item.type === "issue") issueNumbers.add(item.number);
    for (const issueNumber of issueNumbers) {
      const bucket = byIssue.get(issueNumber);
      if (bucket) bucket.push(cluster);
      else byIssue.set(issueNumber, [cluster]);
    }
  }
  return byIssue;
}

function resolveLinkedPullRequests<T extends { number: number }>(
  issue: IssueRecord,
  pullRequests: T[],
  byLinkedIssue: Map<number, T[]>,
  byNumber: Map<number, T>,
): T[] {
  const linkingPrs = byLinkedIssue.get(issue.number) ?? [];
  let addedBackReference = false;
  const matchedNumbers = new Set(linkingPrs.map((pr) => pr.number));
  for (const prNumber of issue.linkedPrs) {
    if (byNumber.has(prNumber) && !matchedNumbers.has(prNumber)) {
      matchedNumbers.add(prNumber);
      addedBackReference = true;
    }
  }
  if (!addedBackReference) return [...linkingPrs];
  return pullRequests.filter((pr) => matchedNumbers.has(pr.number));
}

function classifyIssueDiscoveryLifecycle(
  issue: IssueRecord,
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[],
  lane: LaneAdvice,
  linkedIndex?: { open: Map<number, PullRequestRecord[]>; merged: Map<number, RecentMergedPullRequestRecord[]> },
): LifecycleEntry {
  // With a prebuilt index (the per-repo lifecycle report) look up this issue's linked PRs in O(1); ad-hoc
  // single-issue callers pass no index and fall back to the original filter. buildIssueQualityReport always
  // supplies an index, so the filter fallbacks are defensive mirrors of the host engine.
  /* v8 ignore next 3 -- Ad-hoc no-index path is unused by this module's only caller. */
  const linkedOpenPrs = linkedIndex ? (linkedIndex.open.get(issue.number) ?? []) : pullRequests.filter((pr) => pr.linkedIssues.includes(issue.number));
  /* v8 ignore next 3 -- Ad-hoc no-index path is unused by this module's only caller. */
  const linkedMergedPrs = linkedIndex
    ? (linkedIndex.merged.get(issue.number) ?? [])
    : recentMergedPullRequests.filter((pr) => pr.linkedIssues.includes(issue.number));
  const mergedSolverPrs = [...linkedOpenPrs.filter((pr) => pr.mergedAt || pr.state === "merged"), ...linkedMergedPrs];
  const solvedByPullRequests = [...new Set(mergedSolverPrs.map((pr) => pr.number))].sort((left, right) => left - right);
  const issueAuthorLogin = issue.authorLogin;
  const selfSolvedLoop = Boolean(
    issueAuthorLogin && mergedSolverPrs.length > 0 && mergedSolverPrs.every((pr) => sameLogin(pr.authorLogin, issueAuthorLogin)),
  );
  const labels = issue.labels.map((label) => label.toLowerCase());
  const stale = daysSince(issue.updatedAt ?? issue.createdAt) > 90;
  const duplicate = labels.some((label) => /duplicate/.test(label));
  const invalid = labels.some((label) => /invalid|wontfix|not planned|won't fix/.test(label));
  const state: IssueDiscoveryLifecycleState = duplicate
    ? "duplicate"
    : invalid
      ? "invalid"
      : solvedByPullRequests.length > 0
        ? (lane.lane === "issue_discovery" || lane.lane === "split") && !selfSolvedLoop
          ? "valid_solved"
          : "solved"
        : issue.state !== "open"
          ? "closed_not_solved"
          : stale
            ? "stale"
            : "open";
  const reasons = [
    ...(duplicate ? ["Issue carries duplicate labeling."] : []),
    ...(invalid ? ["Issue carries invalid or not-planned labeling."] : []),
    ...(solvedByPullRequests.length > 0 ? [`Linked solver PR(s): ${solvedByPullRequests.map((number) => `#${number}`).join(", ")}.`] : []),
    ...(selfSolvedLoop ? ["Linked solver PR author matches the issue reporter; cache treats this as solved but not valid issue-discovery evidence."] : []),
    ...(issue.state !== "open" && solvedByPullRequests.length === 0 ? ["Issue is closed without cached solver PR evidence."] : []),
    ...(stale && issue.state === "open" ? ["Issue is stale in cached metadata."] : []),
    ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; lifecycle should not encourage issue filing."] : []),
  ];
  return {
    number: issue.number,
    title: issue.title,
    state,
    solvedByPullRequests,
    reasons: reasons.length > 0 ? reasons : ["Issue is open with no solver or duplicate signal."],
  };
}

function buildLifecycleByIssue(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  recentMergedPullRequests: RecentMergedPullRequestRecord[],
): Map<number, LifecycleEntry> {
  const lane = buildLaneAdvice(repo, fullName);
  const linkedIndex = {
    open: indexPullRequestsByLinkedIssue(pullRequests),
    merged: indexPullRequestsByLinkedIssue(recentMergedPullRequests),
  };
  // Bulk classify the first CAP entries (host engine does the same), then PIN every remaining
  // open issue that reports will evaluate — otherwise an open issue past the slice would be missing
  // from the map while buildIssueQualityReport still iterates it (#6057 / closed #6141).
  const cappedIssues = issues.slice(0, ISSUE_DISCOVERY_LIFECYCLE_REPORT_CAP);
  const cappedNumbers = new Set(cappedIssues.map((issue) => issue.number));
  const pinnedOpenOutsideCap = issues.filter((issue) => issue.state === "open" && !cappedNumbers.has(issue.number));
  const issuesToClassify = pinnedOpenOutsideCap.length > 0 ? [...cappedIssues, ...pinnedOpenOutsideCap] : cappedIssues;
  return new Map(
    issuesToClassify.map((issue) => [issue.number, classifyIssueDiscoveryLifecycle(issue, pullRequests, recentMergedPullRequests, lane, linkedIndex)]),
  );
}

/**
 * Evaluate open issues for contribution readiness.
 *
 * Call signature matches the host engine:
 * `(repo, issues, pullRequests, fullName, bounties?, prebuiltCollisions?, recentMergedPullRequests?)`.
 */
export function buildIssueQualityReport(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  fullName: string,
  bounties: BountyRecord[] = [],
  prebuiltCollisions?: CollisionReport,
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): IssueQualityReport {
  const lane = buildLaneAdvice(repo, fullName);
  const collisions = prebuiltCollisions ?? buildCollisionReport(fullName, issues, pullRequests, recentMergedPullRequests);
  const bountyByIssue = indexBountiesByIssue(bounties);
  const prsByLinkedIssue = indexPullRequestsByLinkedIssue(pullRequests);
  const prByNumber = new Map(pullRequests.map((pr) => [pr.number, pr] as const));
  const mergedPrsByLinkedIssue = indexPullRequestsByLinkedIssue(recentMergedPullRequests);
  const mergedPrByNumber = new Map(recentMergedPullRequests.map((pr) => [pr.number, pr] as const));
  const clustersByIssue = indexCollisionClustersByIssue(collisions.clusters);
  const lifecycleByIssue = buildLifecycleByIssue(repo, issues, pullRequests, fullName, recentMergedPullRequests);
  const reports = issues
    .filter((issue) => issue.state === "open")
    .map((issue) => {
      const linkedPrs = resolveLinkedPullRequests(issue, pullRequests, prsByLinkedIssue, prByNumber);
      const linkedMergedPrs = resolveLinkedPullRequests(issue, recentMergedPullRequests, mergedPrsByLinkedIssue, mergedPrByNumber);
      const issueCollisions = clustersByIssue.get(issue.number) ?? [];
      /* v8 ignore next -- Missing dates normalize to zero age. */
      const age = daysSince(issue.updatedAt ?? issue.createdAt);
      /* v8 ignore next -- Defensive host-mirror fallback; open issues past the CAP are pinned into the map above. */
      const lifecycle = lifecycleByIssue.get(issue.number)?.state ?? "open";
      const bodyLength = issue.body?.trim().length ?? 0;
      const bounty = bountyByIssue.get(bountyIssueKey(fullName, issue.number)) ?? null;
      const bountyLifecycle: BountyLifecycle | null = bounty ? classifyBountyLifecycle(bounty, issue) : null;
      const linkedWorkCount = linkedPrs.length + linkedMergedPrs.length + issue.linkedPrs.length;
      const maintainerAuthored = isMaintainerAuthorAssociation(issue.authorAssociation);
      const maintainerWip = isMaintainerWipIssue(issue);
      const reasons = [
        ...(bodyLength >= 200 ? ["Issue has enough body detail to evaluate."] : []),
        ...(issue.labels.length > 0 ? [`Labels: ${issue.labels.join(", ")}.`] : []),
        ...(linkedWorkCount === 0 ? ["No active PR is linked in cached metadata."] : []),
        ...(bountyLifecycle === "active" ? ["Active bounty context is attached (contribution context, not guaranteed payout)."] : []),
      ];
      const warnings = [
        ...(bodyLength < 80 ? ["Issue body is thin; contributor may need more proof before acting."] : []),
        ...(linkedPrs.length > 0 ? [`${linkedPrs.length} active PR(s) already reference this issue.`] : []),
        ...(linkedMergedPrs.length > 0 ? [`${linkedMergedPrs.length} merged PR(s) already reference this issue.`] : []),
        ...(issue.linkedPrs.length > 0 && linkedPrs.length === 0 && linkedMergedPrs.length === 0
          ? [`Cached issue metadata already references PR(s): ${issue.linkedPrs.map((number) => `#${number}`).join(", ")}.`]
          : []),
        ...(issueCollisions.length > 0 ? ["Potential duplicate or overlapping issue/PR context exists."] : []),
        ...(age > 90 ? ["Issue is stale in cached metadata."] : []),
        ...(lifecycle !== "open" ? [`Issue lifecycle is ${lifecycle.replace(/_/g, " ")}.`] : []),
        ...(lane.lane === "direct_pr" ? ["Repo is direct-PR first; issue filing is not the primary Gittensor lane."] : []),
        ...(bountyLifecycle === "completed" ? ["A completed bounty is attached; the work is likely already solved, not an open opportunity."] : []),
        ...(bountyLifecycle === "cancelled" ? ["A cancelled bounty is attached; this is not an active opportunity."] : []),
        ...(bountyLifecycle === "historical"
          ? ["Historical bounty context is attached; this is not an active opportunity without upstream confirmation."]
          : []),
        ...(bountyLifecycle === "stale" ? ["Bounty context for this issue looks stale; confirm it is still active before acting."] : []),
        ...(bountyLifecycle === "ambiguous" ? ["Bounty state for this issue is ambiguous; verify it before acting."] : []),
        ...(maintainerAuthored && !maintainerWip ? ["Maintainer-authored; confirm it is open for outside contribution before starting."] : []),
        ...(maintainerWip
          ? ["Maintainer-authored and labelled in-progress/internal; not a recommended outside-contributor target without confirmation."]
          : []),
      ];
      const score = clamp(100 - warnings.length * 18 + reasons.length * 5 - (age > 180 ? 15 : 0), 0, 100);
      const bountyBlocks = bountyLifecycle === "completed" || bountyLifecycle === "cancelled" || bountyLifecycle === "historical";
      const bountyCaution = bountyLifecycle === "stale" || bountyLifecycle === "ambiguous";
      // Note: the host engine also has a `score < 45 → hold` arm, but with the current warning vocabulary
      // that arm is unreachable without first matching needs_proof/do_not_use (only two warnings can fire
      // without flipping those statuses). Ready is therefore observationally identical for reachable inputs.
      const status: IssueQualityReport["issues"][number]["status"] =
        linkedWorkCount > 0 ||
        issueCollisions.some((cluster) => cluster.risk === "high") ||
        bountyBlocks ||
        ["duplicate", "invalid", "solved", "valid_solved"].includes(lifecycle)
          ? "do_not_use"
          : maintainerWip || warnings.some((warning) => /thin|stale|direct-PR/i.test(warning)) || bountyCaution || lifecycle === "stale"
            ? "needs_proof"
            : "ready";
      return { number: issue.number, title: issue.title, status, score, reasons, warnings };
    })
    .sort((left, right) => right.score - left.score || left.number - right.number)
    .slice(0, ISSUE_QUALITY_REPORT_CAP);
  return {
    repoFullName: fullName,
    generatedAt: nowIso(),
    lane,
    issues: reports,
    summary: `${reports.length} open issue(s) evaluated; ${reports.filter((report) => report.status === "ready").length} look ready from cached metadata.`,
  };
}
