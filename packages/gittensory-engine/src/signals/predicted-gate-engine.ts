import type {
  AdvisoryFinding,
  BountyLifecycle,
  BountyRecord,
  CollisionCluster,
  CollisionItem,
  CollisionReport,
  IssueQualityReport,
  IssueRecord,
  LaneAdvice,
  PreflightInput,
  PreflightResult,
  PublicReadinessScore,
  PullRequestRecord,
  QueueHealth,
  QueueSignalCounts,
  RecentMergedPullRequestRecord,
  RepositoryRecord,
  SignalFinding,
} from "../types/predicted-gate-types.js";
import { nowIso } from "../utils/json.js";
import { PREFLIGHT_LIMITS } from "./preflight-limits.js";
import { hasValidationNote, isTestPath } from "./test-evidence.js";
import { diffFilePriority } from "../review/diff-file-priority.js";

export type { IssueQualityReport, CollisionReport, CollisionCluster } from "../types/predicted-gate-types.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "when",
  "into",
  "issue",
  "pull",
  "request",
  "add",
  "fix",
  "update",
  "improve",
]);
const MAX_COLLISION_PAIRWISE_ISSUES = 80;
const MAX_COLLISION_PAIRWISE_PULL_REQUESTS = 120;
const MAX_COLLISION_PAIRWISE_RECENT_MERGES = 40;
const ISSUE_DISCOVERY_LIFECYCLE_REPORT_CAP = 300;
const ISSUE_QUALITY_REPORT_CAP = 100;
const REPO_OUTCOME_STALE_OPEN_DAYS = 30;
const REPO_OUTCOME_MIN_DECIDED_SAMPLE = 3;
const REPO_OUTCOME_MERGE_WELL_RATE = 0.7;
const REPO_OUTCOME_CLOSURE_RISK_RATE = 0.34;
const REPO_OUTCOME_MAX_PATTERNS = 12;

export function buildLaneAdvice(repo: RepositoryRecord | null, fullName: string): LaneAdvice {
  const config = repo?.registryConfig;
  if (!repo || !repo.isRegistered || !config) {
    return {
      lane: "unknown",
      repoFullName: fullName,
      summary: "Repository registration is not available in the local LoopOver cache.",
      contributorGuidance: "Do not assume this repo is ready for Gittensor-specific contribution guidance yet.",
      maintainerGuidance: "Refresh the registry snapshot or install the GitHub App so LoopOver can evaluate the repo.",
    };
  }
  if (config.emissionShare <= 0) {
    return {
      lane: "inactive",
      repoFullName: fullName,
      issueDiscoveryShare: config.issueDiscoveryShare,
      directPrShare: 0,
      summary: "Repository is registered but has no active allocation in the current snapshot.",
      contributorGuidance: "Treat this as normal upstream contribution work unless the registry changes.",
      maintainerGuidance: "Do not expect Gittensor-driven contributor flow from this repo while allocation is zero.",
    };
  }
  const issueDiscoveryShare = clamp(config.issueDiscoveryShare, 0, 1);
  const directPrShare = 1 - issueDiscoveryShare;
  if (issueDiscoveryShare === 1) {
    return {
      lane: "issue_discovery",
      repoFullName: fullName,
      issueDiscoveryShare,
      directPrShare,
      summary: "Repository is configured for issue-discovery flow.",
      contributorGuidance: "Focus on high-proof issue discovery and avoid self-resolved issue loops.",
      maintainerGuidance: "Prioritize issue quality, duplicate risk, and whether reports are actionable for outside contributors.",
    };
  }
  if (issueDiscoveryShare === 0) {
    return {
      lane: "direct_pr",
      repoFullName: fullName,
      issueDiscoveryShare,
      directPrShare,
      summary: "Repository is configured for direct PR review.",
      contributorGuidance: "Prefer focused PRs with clear evidence, linked context, and low review churn.",
      maintainerGuidance: "Use PR hygiene, duplicate risk, and test evidence as the primary review filters.",
    };
  }
  return {
    lane: "split",
    repoFullName: fullName,
    issueDiscoveryShare,
    directPrShare,
    summary: "Repository is configured for both issue discovery and direct PR review.",
    contributorGuidance: "Pick one path intentionally: issue discovery for reports, direct PR for implementation.",
    maintainerGuidance: "Check whether each submission is using the right path before reviewing technical detail.",
  };
}

export function buildCollisionReport(
  repoFullName: string,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  recentMergedPullRequests: RecentMergedPullRequestRecord[] = [],
): CollisionReport {
  const openIssues = issues.filter((issue) => issue.state === "open");
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
  const clusters = new Map<string, CollisionCluster>();
  const pullRequestsByLinkedIssue = new Map<number, PullRequestRecord[]>();

  for (const pr of openPullRequests) {
    for (const issueNumber of pr.linkedIssues) {
      const linkedPrs = pullRequestsByLinkedIssue.get(issueNumber) ?? [];
      linkedPrs.push(pr);
      pullRequestsByLinkedIssue.set(issueNumber, linkedPrs);
    }
  }

  for (const issue of openIssues) {
    const linkedPrs = pullRequestsByLinkedIssue.get(issue.number) ?? [];
    if (linkedPrs.length === 0) continue;
    const items = [issueItem(issue), ...linkedPrs.map(prItem)];
    clusters.set(`issue-${issue.number}`, {
      id: `issue-${issue.number}`,
      risk: linkedPrs.length > 1 || issue.linkedPrs.length > 1 ? "high" : "medium",
      reason: `Open PR work references issue #${issue.number}.`,
      items,
    });
  }

  const pairwiseIssues = boundedCollisionIssues(openIssues, openPullRequests);
  const pairwisePullRequests = boundedCollisionPullRequests(openPullRequests);
  const pairwiseRecentMergedPullRequests = recentMergedPullRequests.slice(0, MAX_COLLISION_PAIRWISE_RECENT_MERGES);
  const items = [...pairwiseIssues.map(issueItem), ...pairwisePullRequests.map(prItem), ...pairwiseRecentMergedPullRequests.map(recentMergedItem)];
  const itemTerms = new Map<string, CollisionTerms>();
  for (const item of items) itemTerms.set(itemKey(item), collisionTerms(item));
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      /* v8 ignore next -- Sparse array slots are defensive; collision items are built from bounded lists above. */
      if (!left || !right) continue;
      /* v8 ignore start -- Collision items always carry linkedIssues arrays; nullish defaults are defensive only. */
      const sharedIssue = (left.linkedIssues ?? []).find((issue) => (right.linkedIssues ?? []).includes(issue));
      /* v8 ignore stop */
      if (sharedIssue) {
        const key = [itemKey(left), itemKey(right)].sort().join("--");
        /* v8 ignore next -- Pairwise shared-issue clusters are covered by buildCollisionReport integration tests. */
        if (!clusters.has(key)) {
          clusters.set(key, {
            id: key,
            risk: right.type === "recent_merged_pull_request" || left.type === "recent_merged_pull_request" ? "medium" : "high",
            reason: `Items reference the same linked issue #${sharedIssue}.`,
            items: [left, right],
          });
        }
        continue;
      }
      let leftTerms = itemTerms.get(itemKey(left));
      /* v8 ignore next -- Defensive only: every collision item is pre-indexed in itemTerms before this loop. */
      if (leftTerms === undefined) leftTerms = collisionTerms(left);
      let rightTerms = itemTerms.get(itemKey(right));
      /* v8 ignore next -- Defensive only: every collision item is pre-indexed in itemTerms before this loop. */
      if (rightTerms === undefined) rightTerms = collisionTerms(right);
      const overlap = termOverlap(leftTerms, rightTerms);
      if (overlap.score < 0.58 || overlap.shared < 2) continue;
      // Re-score without path terms: tells us whether title/label overlap ALONE already clears the bar
      // (pre-existing behavior, unaffected) or whether changedFiles tokens are what pushed this pair over —
      // the two false-positive shapes that creates are guarded separately below.
      const titleOnlyOverlap = termOverlap(collisionTerms(left, false), collisionTerms(right, false));
      const pathDrivenMatch = titleOnlyOverlap.score < 0.58 || titleOnlyOverlap.shared < 2;
      if (pathDrivenMatch) {
        // A contributor iterating on their own work (e.g. a follow-up PR touching the same file as their
        // still-open prior PR) is not duplicate effort — self-authored path-only overlap is dropped outright.
        /* v8 ignore start -- Self-authored path-only overlap is covered by collision parity tests. */
        if (isPullRequestShapedItem(left) && isPullRequestShapedItem(right) && Boolean(left.authorLogin) && sameLogin(left.authorLogin, right.authorLogin ?? "")) {
          continue;
        }
        /* v8 ignore stop */
        // Different authors: file paths tokenize into directory segments (src, review, test, unit, ...) that
        // recur across nearly every PR in a consistently-organized repo, so shared TOKENS alone are not
        // reliable collision evidence — a repo-wide shadow test found this drove the large majority of
        // path-only matches with zero actual shared files. Require an ACTUAL shared file (ignoring
        // lockfiles/generated artifacts nobody would call a collision over) before clustering.
        if (!sharesMeaningfulFile(left.changedFiles, right.changedFiles)) continue;
      }
      const key = [itemKey(left), itemKey(right)].sort().join("--");
      /* v8 ignore next -- Duplicate pairwise keys cannot occur in a single nested-loop pass; this guard is defensive only. */
      if (clusters.has(key)) continue;
      clusters.set(key, {
        id: key,
        risk: overlap.score >= 0.75 ? "high" : "medium",
        reason: `Titles/paths share ${overlap.shared} meaningful terms.`,
        items: [left, right],
      });
    }
  }

  const clusterList = [...clusters.values()].sort((left, right) => riskRank(right.risk) - riskRank(left.risk));
  const report = {
    repoFullName,
    generatedAt: nowIso(),
    summary: {
      clusterCount: clusterList.length,
      highRiskCount: clusterList.filter((cluster) => cluster.risk === "high").length,
      itemsReviewed: openIssues.length + openPullRequests.length + recentMergedPullRequests.length,
    },
    clusters: clusterList,
  };
  collisionReportTermCache.set(report, itemTerms);
  return report;
}

export function itemSharesPlannedLinkedIssue(item: CollisionItem, plannedLinkedIssues: number[]): boolean {
  return (item.linkedIssues ?? []).some((issueNumber) => plannedLinkedIssues.includes(issueNumber));
}

export function buildQueueHealth(
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  collisions: CollisionReport,
  countOverrides: QueueSignalCounts = {},
): QueueHealth {
  const repoFullName = repo?.fullName ?? collisions.repoFullName;
  const openIssues = issues.filter((issue) => issue.state === "open");
  const openPullRequests = pullRequests.filter((pr) => pr.state === "open");
  const openIssueCount = Math.max(openIssues.length, countOverrides.openIssues ?? 0);
  const openPullRequestCount = Math.max(openPullRequests.length, countOverrides.openPullRequests ?? 0);
  const likelyReviewablePullRequestsSource =
    countOverrides.likelyReviewablePullRequests !== undefined ? "authoritative" : openPullRequestCount > openPullRequests.length ? "sampled_cache" : "cache";
  const unlinkedPullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length === 0);
  const stalePullRequests = openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) >= 14);
  const draftPullRequests = openPullRequests.filter((pr) => pr.isDraft);
  const maintainerAuthoredPullRequests = openPullRequests.filter((pr) => isMaintainerAssociation(pr.authorAssociation));
  const slopFlaggedPullRequests = openPullRequests.filter(
    (pr) => pr.slopBand === "elevated" || pr.slopBand === "high",
  ).length;
  const highRiskDuplicatePrNumbers = new Set(
    collisions.clusters
      .filter(
        (cluster) =>
          cluster.risk === "high" &&
          cluster.items.filter((item) => item.type === "pull_request").length >= 2,
      )
      .flatMap((cluster) =>
        cluster.items.filter((item) => item.type === "pull_request").map((item) => item.number),
      ),
  );
  const duplicateFlaggedPullRequests = openPullRequests.filter((pr) =>
    highRiskDuplicatePrNumbers.has(pr.number),
  ).length;
  const cachedLikelyReviewablePullRequests = openPullRequests.filter((pr) => pr.linkedIssues.length > 0 && daysSince(pr.updatedAt ?? pr.createdAt) < 30).length;
  const likelyReviewablePullRequests = Math.min(openPullRequestCount, Math.max(cachedLikelyReviewablePullRequests, countOverrides.likelyReviewablePullRequests ?? 0));
  const ageBuckets = {
    under7Days: openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) < 7).length,
    days7To30: openPullRequests.filter((pr) => {
      const age = daysSince(pr.updatedAt ?? pr.createdAt);
      return age >= 7 && age <= 30;
    }).length,
    over30Days: openPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) > 30).length,
  };
  const burdenScore = clamp(
    openPullRequestCount * 6 +
      openIssueCount +
      unlinkedPullRequests.length * 8 +
      stalePullRequests.length * 6 +
      ageBuckets.over30Days * 4 +
      collisions.summary.clusterCount * 10 -
      likelyReviewablePullRequests * 2,
    0,
    100,
  );
  let level: QueueHealth["level"] = "low";
  if (burdenScore >= 80) level = "critical";
  else if (burdenScore >= 55) level = "high";
  else if (burdenScore >= 25) level = "medium";
  const findings: SignalFinding[] = [];
  if (unlinkedPullRequests.length > 0) {
    findings.push({
      code: "unlinked_prs",
      severity: "warning",
      title: "Open PRs are missing linked issue context",
      detail: `${unlinkedPullRequests.length} open pull request(s) in the local cache do not reference a closing issue.`,
      action: "Ask contributors to link relevant issues or explain no-issue PR intent clearly.",
    });
  }
  if (collisions.summary.clusterCount > 0) {
    findings.push({
      code: "collision_clusters",
      severity: collisions.summary.highRiskCount > 0 ? "warning" : "info",
      title: "Duplicate or overlapping work is visible",
      detail: `${collisions.summary.clusterCount} possible overlap cluster(s) were detected.`,
      action: "Review overlapping submissions before spending detailed review time.",
    });
  }
  if (stalePullRequests.length > 0) {
    findings.push({
      code: "stale_prs",
      severity: "info",
      title: "Some open PRs appear stale",
      detail: `${stalePullRequests.length} open pull request(s) have not updated in at least 14 days.`,
    });
  }
  const inactiveDraftPullRequests = draftPullRequests.filter((pr) => daysSince(pr.updatedAt ?? pr.createdAt) >= 14);
  if (inactiveDraftPullRequests.length > 0) {
    findings.push({
      code: "inactive_draft_prs",
      severity: "info",
      title: "Draft PRs have been open without recent activity",
      detail: `${inactiveDraftPullRequests.length} draft pull request(s) have not updated in at least 14 days — they may be abandoned or blocked.`,
      action: "Mark as ready for review when work resumes, or close if the approach has been abandoned.",
    });
  }
  return {
    repoFullName,
    generatedAt: nowIso(),
    burdenScore,
    level,
    summary: `Queue burden is ${level} with ${openPullRequestCount} open PR(s), ${openIssueCount} open issue(s), and ${collisions.summary.clusterCount} overlap cluster(s).`,
    signals: {
      openIssues: openIssueCount,
      openPullRequests: openPullRequestCount,
      unlinkedPullRequests: unlinkedPullRequests.length,
      stalePullRequests: stalePullRequests.length,
      draftPullRequests: draftPullRequests.length,
      maintainerAuthoredPullRequests: maintainerAuthoredPullRequests.length,
      collisionClusters: collisions.summary.clusterCount,
      slopFlaggedPullRequests,
      duplicateFlaggedPullRequests,
      ageBuckets,
      likelyReviewablePullRequests,
      cachedOpenPullRequests: openPullRequests.length,
      likelyReviewablePullRequestsSource,
    },
    findings,
  };
}

export function buildPreflightResult(
  input: PreflightInput,
  repo: RepositoryRecord | null,
  issues: IssueRecord[],
  pullRequests: PullRequestRecord[],
  bounties: BountyRecord[] = [],
  issueQuality?: IssueQualityReport | null | undefined,
  // Default true so every existing caller (which predates this param) keeps its exact prior behavior.
  registryEverSynced = true,
): PreflightResult {
  const lane = buildLaneAdvice(repo, input.repoFullName);
  const linkedIssues = [...new Set([...(input.linkedIssues ?? []), ...extractLinkedIssueNumbers(truncateText(input.body ?? "", PREFLIGHT_LIMITS.bodyChars), input.repoFullName)])].sort(
    (left, right) => left - right,
  );
  // Flag an existing open-work cluster as a possible duplicate when it shares a
  // linked issue, OR when its title/body meaningfully overlaps the planned
  // contribution. The previous check used `item.title.includes(input.title)`,
  // which only matched when an existing item's title contained the *entire*
  // planned title — so a typical (longer, more descriptive) planned PR title
  // never matched a shorter duplicate issue, silently suppressing the warning,
  // while a short planned title spuriously matched unrelated items. Use the same
  // symmetric term-overlap heuristic `buildCollisionReport` uses between items
  // (>=2 shared meaningful terms), which is direction-independent.
  const plannedTerms = plannedContributionTerms(input);
  const collisionReport = buildCollisionReport(input.repoFullName, issues, pullRequests);
  let cachedItemTerms = collisionReportTermCache.get(collisionReport);
  /* v8 ignore next -- Defensive only: buildCollisionReport always seeds term maps before preflight reads them. */
  if (cachedItemTerms === undefined) cachedItemTerms = new Map<string, CollisionTerms>();
  const itemTerms = cachedItemTerms;
  const collisions = collisionReport.clusters.filter((cluster) =>
    cluster.items.some((item) => {
      if (itemSharesPlannedLinkedIssue(item, linkedIssues)) {
        return true;
      }
      const overlap = termOverlap(plannedTerms, (() => {
        let terms = itemTerms.get(itemKey(item));
        /* v8 ignore next -- Defensive only: collision item terms are cached for every cluster item. */
        if (terms === undefined) terms = collisionTerms(item);
        return terms;
      })());
      return overlap.shared >= 2 && overlap.score >= 0.5;
    }),
  );
  const findings: SignalFinding[] = [];
  // An "unknown" lane means "not found in the local registry cache", which is genuinely ambiguous: it's the
  // same result whether this repo simply isn't registered in a WORKING snapshot, or the registry sync has
  // never once succeeded (a self-host connectivity/config problem with no bearing on this PR at all). Only
  // treat "unknown" as a real signal once we know the sync mechanism itself has produced at least one
  // snapshot; "inactive" (zero emission share) is unambiguous either way -- it is only reachable from real
  // synced data.
  const laneUnavailable = (lane.lane === "unknown" && registryEverSynced) || lane.lane === "inactive";
  const maintainerAuthored = isMaintainerAssociation(input.authorAssociation);
  if (laneUnavailable) {
    findings.push({
      code: "lane_not_recommended",
      severity: maintainerAuthored ? "info" : "warning",
      title: maintainerAuthored ? "Repo lane unavailable for contributor scoring" : "Repo lane is not ready for a confident recommendation",
      detail: maintainerAuthored ? `${lane.summary} Maintainer-authored work is treated as repo stewardship, not contributor-lane eligibility.` : lane.summary,
      action: maintainerAuthored ? "No action." : "Refresh registry data or choose a registered active repo.",
    });
  }
  if (linkedIssues.length === 0 && lane.lane !== "issue_discovery") {
    findings.push({
      code: "missing_linked_issue",
      severity: "warning",
      title: "No linked issue detected",
      detail: "The planned PR does not reference a closing issue or explicit linked issue number.",
      action: "Link the issue being solved, or explicitly explain why this is a no-issue PR.",
    });
  }
  if (collisions.length > 0) {
    findings.push({
      code: "possible_duplicate_work",
      /* v8 ignore next -- High-risk severity is covered through collision reports; info-only clusters are presentation fallback. */
      severity: collisions.some((cluster) => cluster.risk === "high") ? "warning" : "info",
      title: "Possible duplicate or overlapping work",
      detail: `${collisions.length} related open work cluster(s) were detected.`,
      action: "Check active issues and PRs before submitting.",
    });
  }
  const bountyByIssue = indexBountiesByIssue(bounties);
  for (const issueNumber of linkedIssues) {
    const bounty = bountyByIssue.get(bountyIssueKey(input.repoFullName, issueNumber));
    if (!bounty) continue;
    const linkedIssue = issues.find((candidate) => candidate.repoFullName.toLowerCase() === input.repoFullName.toLowerCase() && candidate.number === issueNumber) ?? null;
    const lifecycle = classifyBountyLifecycle(bounty, linkedIssue);
    if (isHistoricalBountyLifecycle(lifecycle)) {
      findings.push({
        code: "linked_issue_bounty_historical",
        severity: "info",
        title: "Linked issue bounty is historical",
        detail: `Issue #${issueNumber} has a ${lifecycle} bounty; confirm the work is still wanted before investing in it.`,
        action: "Verify the bounty and issue are still open upstream.",
      });
    } else if (lifecycle === "stale") {
      findings.push({
        code: "linked_issue_bounty_unverified",
        severity: "warning",
        title: "Linked issue bounty needs verification",
        detail: `Issue #${issueNumber} has a ${lifecycle} bounty; confirm it is still active before relying on it as contribution context.`,
        action: "Re-check the upstream bounty source before submitting.",
      });
    } else if (lifecycle === "ambiguous") {
      findings.push({
        code: "linked_issue_bounty_unverified",
        severity: "warning",
        title: "Linked issue bounty needs verification",
        detail: `Issue #${issueNumber} has a ${lifecycle} bounty; confirm it is still active before relying on it as contribution context.`,
        action: "Re-check the upstream bounty source before submitting.",
      });
    }
  }
  findings.push(...issueQualityFindings(linkedIssues, issueQuality));
  const changedFiles = input.changedFiles ?? [];
  const tests = input.tests ?? [];
  if (changedFiles.some((file) => isCodeFile(file)) && tests.length === 0 && !changedFiles.some((file) => isTestFile(file))) {
    findings.push({
      code: "missing_test_evidence",
      severity: "warning",
      title: "No test evidence supplied",
      detail: "Code files are listed, but no tests or test files were supplied in preflight input.",
      action: "Add focused test evidence or explain why existing coverage is sufficient.",
    });
  }
  const reviewBurden = changedFiles.length >= 12 || collisions.length > 0 ? "high" : changedFiles.length >= 5 ? "medium" : "low";
  const hasWarning = findings.some((finding) => finding.severity === "warning" || finding.severity === "critical");
  return {
    repoFullName: input.repoFullName,
    generatedAt: nowIso(),
    status: laneUnavailable && !maintainerAuthored ? "hold" : hasWarning ? "needs_work" : "ready",
    lane,
    reviewBurden,
    linkedIssues,
    findings,
    collisions,
  };
}

function issueQualityFindings(linkedIssues: number[], issueQuality: IssueQualityReport | null | undefined): SignalFinding[] {
  if (!issueQuality || linkedIssues.length === 0) return [];
  const byIssue = new Map(issueQuality.issues.map((issue) => [issue.number, issue]));
  return linkedIssues.flatMap((issueNumber) => {
    const quality = byIssue.get(issueNumber);
    if (!quality || quality.status === "ready") return [];
    const detail = quality.warnings[0] ?? `Issue quality report marks #${issueNumber} as ${quality.status}.`;
    if (quality.status === "do_not_use") {
      return [
        {
          code: "issue_quality_do_not_use",
          severity: "warning" as const,
          title: "Linked issue is already covered or duplicate-prone",
          detail,
          action: "Confirm the linked issue is still actionable before posting public PR context.",
        },
      ];
    }
    if (quality.status === "needs_proof") {
      return [
        {
          code: "issue_quality_needs_proof",
          severity: "warning" as const,
          title: "Linked issue needs stronger proof",
          detail,
          action: "Add concrete reproduction, scope, or maintainer context before proceeding.",
        },
      ];
    }
    return [
      {
        code: "issue_quality_hold",
        severity: "warning" as const,
        title: "Linked issue is on hold",
        detail,
        action: "Choose a clearer candidate or wait for maintainer context.",
      },
    ];
  });
}

export const BOUNTY_STALE_DAYS = 45;

export function bountyIssueKey(repoFullName: string, issueNumber: number): string {
  return `${repoFullName.toLowerCase()}#${issueNumber}`;
}

export function indexBountiesByIssue(bounties: BountyRecord[]): Map<string, BountyRecord> {
  const map = new Map<string, BountyRecord>();
  for (const bounty of bounties) {
    map.set(bountyIssueKey(bounty.repoFullName, bounty.issueNumber), bounty);
  }
  return map;
}

export function classifyBountyLifecycle(bounty: BountyRecord, issue: IssueRecord | null): BountyLifecycle {
  const status = bounty.status.trim().toLowerCase();
  if (!status) return "unknown";
  if (/cancel|void|expired|withdrawn|rejected|abandon/.test(status)) return "cancelled";
  // Only past-tense payout phrasing (rewarded/awarded) marks completion; a bounty that merely
  // advertises a "reward"/"award" is an active offer, not already-completed work.
  if (/complete|paid|resolved|rewarded|awarded|fulfil|merged|claimed|done/.test(status)) return "completed";
  if (/historical|archived|closed/.test(status)) return "historical";
  const looksActive = /open|active|live|available|ready|funded|reward|award|in[\s_-]?progress|todo|new/.test(status);
  if (!looksActive) return "ambiguous";
  // Active-looking status: reconcile against the linked issue and freshness so dead context is not treated as live.
  if (issue && issue.state !== "open") return "ambiguous";
  if (daysSince(bounty.updatedAt ?? bounty.discoveredAt) > BOUNTY_STALE_DAYS) return "stale";
  return "active";
}

export function isHistoricalBountyLifecycle(lifecycle: BountyLifecycle): boolean {
  return lifecycle === "historical" || lifecycle === "completed" || lifecycle === "cancelled";
}

export function buildPublicReadinessScore(args: {
  pr: PullRequestRecord;
  preflight: PreflightResult;
  queueHealth: QueueHealth;
  linkedDuplicatePrs?: number[] | undefined;
  scopedOverlapCount?: number | undefined;
}): PublicReadinessScore {
  const linkedIssues = args.pr.linkedIssues;
  const hasNoIssueRationale = hasClearNoIssueRationale(args.pr);
  const linkedDuplicatePrs = args.linkedDuplicatePrs ?? [];
  const scopedOverlapCount = args.scopedOverlapCount ?? 0;
  const reviewLoadScore = reviewLoadComponentScore(args.preflight.reviewBurden);
  const validation = validationComponent(args.pr, args.preflight);
  const queuePressure = queuePressureComponent(args.queueHealth);
  const components: PublicReadinessScore["components"] = [
    {
      key: "traceability",
      label: "Traceability",
      score: linkedIssues.length > 0 || hasNoIssueRationale ? 15 : 8,
      max: 15,
      evidence:
        linkedIssues.length > 0
          ? `Linked issue${linkedIssues.length === 1 ? "" : "s"} ${formatIssueRefs(linkedIssues)}.`
          : hasNoIssueRationale
            ? "PR body includes a no-issue rationale."
            : "No linked issue or no-issue rationale found.",
      action: linkedIssues.length > 0 || hasNoIssueRationale ? "No action." : "Explain no-issue PR.",
    },
    {
      key: "related_work",
      label: "Related work",
      score: linkedDuplicatePrs.length > 0 ? 8 : scopedOverlapCount > 0 ? 14 : 20,
      max: 20,
      evidence:
        linkedDuplicatePrs.length > 0
          ? `Same linked issue with ${formatPrRefs(linkedDuplicatePrs)}.`
          : scopedOverlapCount > 0
            ? `${Math.min(scopedOverlapCount, 3)} scoped overlap${Math.min(scopedOverlapCount, 3) === 1 ? "" : "s"} found.`
            : "No active overlap found.",
      action: linkedDuplicatePrs.length > 0 ? `Compare ${formatPrRefs(linkedDuplicatePrs)}.` : scopedOverlapCount > 0 ? "Review top overlaps." : "No action.",
    },
    {
      key: "change_scope",
      label: "Change scope",
      score: reviewLoadScore,
      max: 20,
      evidence: changeScopeEvidence(args.pr, args.preflight.reviewBurden),
      action: reviewLoadScore >= 18 ? "No action." : "Add a concise scope and risk note.",
    },
    {
      key: "validation",
      label: "Validation posture",
      score: validation.score,
      max: 25,
      evidence: validation.evidence,
      action: validation.action,
    },
    {
      key: "pr_state",
      label: "PR state",
      score: args.pr.state === "open" && !args.pr.isDraft ? 10 : args.pr.state === "open" ? 6 : 3,
      max: 10,
      evidence: args.pr.isDraft ? "PR is open as draft." : `PR state is ${args.pr.state}.`,
      action: args.pr.state === "open" && !args.pr.isDraft ? "No action." : args.pr.isDraft ? "Mark ready when done." : "No action.",
    },
    {
      key: "queue_pressure",
      label: "Review queue context",
      score: queuePressure.score,
      max: queuePressure.max,
      evidence: queuePressure.evidence,
      action: queuePressure.action,
    },
  ];
  return {
    total: clamp(
      components.reduce((sum, component) => sum + component.score, 0),
      0,
      100,
    ),
    components,
  };
}

function pullRequestSpecificCollisionClusters(report: CollisionReport, pr: PullRequestRecord): CollisionCluster[] {
  return report.clusters.filter((cluster) => cluster.items.some((item) => item.type === "pull_request" && item.number === pr.number));
}

/** Deduplicated union of PR-specific collision clusters and preflight overlap clusters. */
export function unionScopedOverlapClusters(
  report: CollisionReport,
  pr: PullRequestRecord,
  preflightCollisions: CollisionCluster[],
): CollisionCluster[] {
  const prCollisionClusters = pullRequestSpecificCollisionClusters(report, pr);
  return [...new Map([...prCollisionClusters, ...preflightCollisions].map((cluster) => [cluster.id, cluster])).values()];
}

function sanitizePanelText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function changeScopeEvidence(pr: PullRequestRecord, reviewBurden: PreflightResult["reviewBurden"]): string {
  const burden = reviewBurden === "low" ? "Low" : reviewBurden === "medium" ? "Medium" : "High";
  const sizeLabel = pr.labels.find((label) => /^size[:/-]/i.test(label));
  const detailParts = [
    sizeLabel ? `size label ${sanitizePanelText(sizeLabel)}` : undefined,
    pr.isDraft ? "draft PR" : undefined,
    pr.linkedIssues.length > 0 ? `${pr.linkedIssues.length} linked issue${pr.linkedIssues.length === 1 ? "" : "s"}` : "no linked issue context",
  ].filter(Boolean);
  return `${burden} review scope from cached public metadata (${detailParts.join("; ")}).`;
}

function reviewLoadComponentScore(reviewBurden: PreflightResult["reviewBurden"]): number {
  if (reviewBurden === "low") return 20;
  if (reviewBurden === "medium") return 14;
  return 8;
}

function validationComponent(pr: PullRequestRecord, preflight: PreflightResult): { score: number; evidence: string; action: string } {
  const findingCodes = preflight.findings.map((finding) => finding.code);
  const missingTests = findingCodes.some((code) => /missing.*test|test.*missing|no_test/i.test(code));
  const explicitValidation = hasValidationNote(pr.body ?? "");
  if (preflight.status === "hold") {
    return { score: 5, evidence: "Preflight is holding this PR: the review lane is unavailable, so it is not ready for automated review.", action: "Await review-lane availability." };
  }
  if (missingTests) {
    // A body validation note is an UNBACKED claim when no test files accompany the change. Cap it just above the
    // no-signal floor so a one-line "tested" cannot lift readiness over a configured gate threshold on a
    // zero-test PR — full credit is reserved for actual test evidence in the branch below. (#audit-2.3)
    return explicitValidation
      ? { score: 12, evidence: "PR body claims validation but no test files accompany the change.", action: "Add tests covering the change." }
      : { score: 10, evidence: "No cached test files or validation note found.", action: "Add tests or validation evidence." };
  }
  if (explicitValidation) {
    return { score: 25, evidence: "PR body includes validation/test evidence.", action: "No action." };
  }
  if (preflight.status === "ready") {
    return { score: 20, evidence: "Preflight is ready, but the PR body does not name the validation run.", action: "Add validation command/output." };
  }
  return { score: 12, evidence: "Preflight needs author follow-up before maintainer review.", action: "Address findings or add validation evidence." };
}

function queuePressureComponent(queueHealth: QueueHealth): { score: number; max: 10; evidence: string; action: string } {
  const signals = queueHealth.signals;
  const openPullRequests = Math.max(0, signals.openPullRequests);
  const cachedOpenPullRequests = Math.max(0, signals.cachedOpenPullRequests ?? signals.ageBuckets.under7Days + signals.ageBuckets.days7To30 + signals.ageBuckets.over30Days);
  const likelyReviewablePullRequests = Math.max(0, Math.min(openPullRequests, signals.likelyReviewablePullRequests));
  const sampledLikelyReviewable = signals.likelyReviewablePullRequestsSource === "sampled_cache" || (signals.likelyReviewablePullRequestsSource === undefined && cachedOpenPullRequests < openPullRequests);
  const score = queuePressureScore(openPullRequests);
  const likelyEvidence =
    openPullRequests === 0
      ? "0 likely reviewable"
      : sampledLikelyReviewable
        ? cachedOpenPullRequests > 0
          ? `${likelyReviewablePullRequests} likely reviewable in ${cachedOpenPullRequests} cached PR(s); full queue reviewability is sampled`
          : "likely-reviewable count unavailable from cached PR metadata"
        : `${likelyReviewablePullRequests} likely reviewable`;
  const detailParts = [
    `${openPullRequests} open PR(s)`,
    likelyEvidence,
    signals.stalePullRequests > 0 ? `${signals.stalePullRequests} stale` : undefined,
    signals.unlinkedPullRequests > 0 ? `${signals.unlinkedPullRequests} unlinked` : undefined,
  ].filter(Boolean);
  return {
    score,
    max: 10,
    evidence: `Repo queue: ${detailParts.join(", ")}.`,
    action: score >= 8 ? "No action." : "Triage stale or unlinked PRs.",
  };
}

function queuePressureScore(openPullRequests: number): number {
  if (openPullRequests === 0) return 10;
  return queuePressureOpenPullRequestScore(openPullRequests);
}

function queuePressureOpenPullRequestScore(openPullRequests: number): number {
  if (openPullRequests <= 4) return 10;
  if (openPullRequests <= 8) return 8;
  if (openPullRequests <= 13) return 5;
  return 3;
}

export function hasClearNoIssueRationale(pr: Pick<PullRequestRecord, "title" | "body">): boolean {
  // `docs?[\s-]+only` matches the space form ("docs only") AND the hyphenated "docs-only" / "doc-only"
  // spelling this function's own docstring uses — the dominant GitHub/Conventional-Commits form. A bare
  // `docs? only` missed the hyphen, so a docs-only PR with no linked issue was wrongly denied a clear
  // no-issue rationale and hard-blocked under `linkedIssueGateMode === "block"`.
  // `tests?[\s-]+only` extends the same rule to test-only PRs (regression/coverage-only diffs) — parallel
  // to the docs-only hyphenation fix merged in #1905 and the test-only follow-up in #1993.
  // `ci[\s-]+only` covers CI/workflow-only PRs using the same Conventional Commits spelling.
  // `refactor[\s-]+only` covers internal refactors with no behavior change using the same spelling.
  return /\b(?:no issue\s*(?:because\b|:)|no linked issue\s*(?:because\b|:)|no ticket\s*(?:because\b|:)|(?:maintenance|docs?[\s-]+only|tests?[\s-]+only|ci[\s-]+only|refactor[\s-]+only|typo|chore|cleanup)\b)/i.test([pr.title, pr.body ?? ""].join(" "));
}

function formatPrRefs(numbers: number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

function formatIssueRefs(numbers: number[]): string {
  return numbers.map((number) => `#${number}`).join(", ");
}

function issueItem(issue: IssueRecord): CollisionItem {
  return {
    type: "issue",
    number: issue.number,
    title: issue.title,
    authorLogin: issue.authorLogin,
    htmlUrl: issue.htmlUrl,
    labels: issue.labels,
    linkedIssues: [issue.number],
    body: issue.body,
  };
}

function prItem(pr: PullRequestRecord): CollisionItem {
  return {
    type: "pull_request",
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    htmlUrl: pr.htmlUrl,
    labels: pr.labels,
    linkedIssues: pr.linkedIssues,
    linkedIssueClaimedAt: pr.linkedIssueClaimedAt,
    changedFiles: pr.changedFiles,
    body: pr.body,
  };
}

function recentMergedItem(pr: RecentMergedPullRequestRecord): CollisionItem {
  return {
    type: "recent_merged_pull_request",
    number: pr.number,
    title: pr.title,
    authorLogin: pr.authorLogin,
    htmlUrl: pr.htmlUrl,
    labels: pr.labels,
    linkedIssues: pr.linkedIssues,
    changedFiles: pr.changedFiles,
  };
}

function itemKey(item: CollisionItem): string {
  return `${item.type}-${item.number}`;
}

function boundedCollisionIssues(openIssues: IssueRecord[], openPullRequests: PullRequestRecord[]): IssueRecord[] {
  /* v8 ignore start -- Large-queue sampling is a deterministic guard; standard and linked collision paths are covered above. */
  if (openIssues.length <= MAX_COLLISION_PAIRWISE_ISSUES) return openIssues;
  const linkedIssueNumbers = new Set(openPullRequests.flatMap((pr) => pr.linkedIssues));
  const selected = new Map<number, IssueRecord>();
  for (const issue of openIssues) {
    if (linkedIssueNumbers.has(issue.number)) selected.set(issue.number, issue);
    if (selected.size >= MAX_COLLISION_PAIRWISE_ISSUES) return [...selected.values()];
  }
  for (const issue of openIssues) {
    selected.set(issue.number, issue);
    if (selected.size >= MAX_COLLISION_PAIRWISE_ISSUES) break;
  }
  return [...selected.values()];
  /* v8 ignore stop */
}

function boundedCollisionPullRequests(openPullRequests: PullRequestRecord[]): PullRequestRecord[] {
  /* v8 ignore start -- Large-queue PR sampling mirrors boundedCollisionIssues; linked and pairwise collision paths are covered above. */
  if (openPullRequests.length <= MAX_COLLISION_PAIRWISE_PULL_REQUESTS) return openPullRequests;
  // Rank linked-issue PRs ahead of unlinked ones, then by recency within each group, so the cap keeps
  // the most-relevant PRs even when linked PRs alone exceed the budget (not just whichever appear
  // first in caller order).
  const ranked = [...openPullRequests].sort(
    (left, right) =>
      Number(left.linkedIssues.length === 0) - Number(right.linkedIssues.length === 0) ||
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      left.number - right.number,
  );
  return ranked.slice(0, MAX_COLLISION_PAIRWISE_PULL_REQUESTS);
  /* v8 ignore stop */
}

export type CollisionTerms = {
  terms: Set<string>;
  size: number;
};

const collisionReportTermCache = new WeakMap<CollisionReport, Map<string, CollisionTerms>>();

function collisionTerms(item: CollisionItem, includePaths = true): CollisionTerms {
  const terms = new Set(tokenize(collisionItemText(item, includePaths)));
  return { terms, size: terms.size };
}

/**
 * Tokenized terms for the planned contribution, used to detect overlap with
 * existing open work. Mirrors `collisionTerms` so the planned PR is compared to
 * collision items with the same term-overlap heuristic `buildCollisionReport`
 * uses between items, rather than a one-direction substring test.
 */
function plannedContributionTerms(input: PreflightInput): CollisionTerms {
  const terms = new Set(
    tokenize(
      [
        truncateText(input.title, PREFLIGHT_LIMITS.titleChars),
        ...boundedTextItems(input.labels, PREFLIGHT_LIMITS.labels, PREFLIGHT_LIMITS.labelChars),
        ...boundedTextItems(input.changedFiles, PREFLIGHT_LIMITS.changedFiles, PREFLIGHT_LIMITS.changedFileChars),
      ].join(" "),
    ),
  );
  return { terms, size: terms.size };
}

export function termOverlap(left: CollisionTerms, right: CollisionTerms): { score: number; shared: number } {
  if (left.size === 0) return { score: 0, shared: 0 };
  if (right.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  const [smaller, larger] = left.size <= right.size ? [left.terms, right.terms] : [right.terms, left.terms];
  for (const term of smaller) {
    if (larger.has(term)) shared += 1;
  }
  return { score: shared / Math.min(left.size, right.size), shared };
}

function collisionItemText(item: CollisionItem, includePaths = true): string {
  return [
    truncateText(item.title, PREFLIGHT_LIMITS.titleChars),
    ...boundedTextItems(item.labels, PREFLIGHT_LIMITS.labels, PREFLIGHT_LIMITS.labelChars),
    ...(includePaths ? boundedTextItems(item.changedFiles, PREFLIGHT_LIMITS.changedFiles, PREFLIGHT_LIMITS.changedFileChars) : []),
  ]
    .filter(Boolean)
    .join(" ");
}

function boundedTextItems(values: string[] | undefined, maxItems: number, maxChars: number): string[] {
  return (values ?? []).slice(0, maxItems).map((value) => truncateText(value, maxChars));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

// Exported (#3183) so the project/milestone text matcher (src/integrations/project-tracker-adapter.ts) can
// reuse the exact same term-overlap heuristic already proven here for duplicate-PR collision detection, rather
// than re-implementing a second, subtly different tokenizer.
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
}

function extractLinkedIssueNumbers(text: string, repoFullName: string): number[] {
  const numbers = [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((match) => Number(match[1]));
  // GitHub also auto-closes via the fully-qualified `KEYWORD owner/repo#N` form (e.g. Renovate/Dependabot bodies).
  // Count it only when owner/repo case-insensitively equals THIS repo — a reference to a different repo closes an
  // issue elsewhere, not here, so it must not spoof a same-repo link. Same `\b`-anchored keywords as above (#1988).
  const target = repoFullName.toLowerCase();
  for (const match of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+([\w.-]+\/[\w.-]+)#(\d+)\b/gi)) {
    if (match[1]!.toLowerCase() === target) numbers.push(Number(match[2]));
  }
  return [...new Set(numbers.filter((value) => Number.isInteger(value) && value > 0))];
}

function isMaintainerAssociation(value: string | null | undefined): boolean {
  return value === "OWNER" || value === "MEMBER" || value === "COLLABORATOR";
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function isPullRequestShapedItem(item: CollisionItem): boolean {
  return item.type === "pull_request" || item.type === "recent_merged_pull_request";
}

/** True when two changed-file lists share at least one path that isn't a lockfile/generated/vendor artifact
 *  (diffFilePriority's least-useful-to-review bucket) — a shared package-lock.json or dist/ output is touched
 *  incidentally by unrelated PRs and is not evidence of a real collision. */
function sharesMeaningfulFile(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) return false;
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((path) => rightSet.has(path) && diffFilePriority(path) < 4);
}

function daysSince(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  /* v8 ignore next -- Invalid provider timestamps normalize to fresh; stale timestamp handling is covered by signal tests. */
  if (!Number.isFinite(parsed)) return 0;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}


function isCodeFile(file: string): boolean {
  // Mirrors isCodeFile in local-branch.ts — kept in sync (cs/swift/groovy/php and C/C++/Objective-C added
  // so native/C#/Swift/Groovy/PHP source counts as code, matching the test conventions
  // isTestPath already recognizes; vue/svelte/astro match rag.ts, visual paths, and isCodePath;
  // cc/hpp complete the C++ extension set alongside cpp/c/h; dart matches rag.ts and
  // test-evidence's *_test.dart test convention).
  return (
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|rs|kt|scala|java|go|sql|cs|swift|groovy|php|cpp|cc|c|h|hpp|m|vue|svelte|astro|dart)$/i.test(
      file,
    ) && !isTestFile(file)
  );
}

function isTestFile(file: string): boolean {
  // Single-sourced with the canonical matcher (test-evidence.ts isTestPath), mirroring local-branch.ts's
  // isTestFile — so cy/e2e, __snapshots__, and module extensions stay in sync and can't drift.
  return isTestPath(file);
}

function riskRank(risk: CollisionCluster["risk"]): number {
  if (risk === "high") return 3;
  /* v8 ignore next -- Low collision rank is the default branch; high/medium sorting behavior is covered by collision tests. */
  if (risk === "medium") return 2;
  /* v8 ignore next -- Collision clusters are only assigned medium/high risk today; low is the unreachable default. */
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** @internal Exported for unit tests of predicted-gate engine helpers. */
export const predictedGateEngineInternals = {
  sharesMeaningfulFile,
  truncateText,
  extractLinkedIssueNumbers,
  changeScopeEvidence,
  reviewLoadComponentScore,
  validationComponent,
  queuePressureComponent,
  queuePressureOpenPullRequestScore,
};
