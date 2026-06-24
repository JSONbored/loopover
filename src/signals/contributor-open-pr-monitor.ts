import { listContributorPullRequests, listPullRequestFiles, listPullRequests, listRepositories } from "../db/repositories";
import { sanitizePublicComment } from "../github/commands";
import {
  classifyOpenPullRequest,
  detectPendingPrScenario,
  loadContributorRepoOpenPrSignals,
  type ClassifiedOpenPullRequest,
  type PendingPrScenarioDetection,
} from "../scoring/pending-pr-scenarios";
import type { CheckSummaryRecord, PullRequestFileRecord, PullRequestRecord, PullRequestReviewRecord } from "../types";
import { nowIso } from "../utils/json";
import { buildRoleContext } from "./engine";
import { isTestPath } from "./test-evidence";

export type OpenPrWorkClassification =
  | "approved"
  | "blocked"
  | "stale"
  | "needs_author"
  | "failing_checks"
  | "missing_tests"
  | "duplicate_prone"
  | "reviewable"
  | "should_close_or_withdraw"
  | "maintainer_lane"
  | "draft";

export type ContributorOpenPrNextStepPacket = {
  repoFullName: string;
  number: number;
  title: string;
  classification: OpenPrWorkClassification;
  summary: string;
  reasons: string[];
  nextSteps: string[];
};

export type ContributorOpenPrMonitor = {
  login: string;
  generatedAt: string;
  openPrCount: number;
  registeredRepoCount: number;
  cleanupFirst: boolean;
  summary: string;
  guidance: string[];
  pendingScenarios: Array<{ repoFullName: string; detection: PendingPrScenarioDetection }>;
  pullRequests: ContributorOpenPrNextStepPacket[];
};

export async function buildContributorOpenPrMonitor(env: Env, login: string): Promise<ContributorOpenPrMonitor> {
  const [pullRequests, repositories] = await Promise.all([listContributorPullRequests(env, login), listRepositories(env)]);
  const registered = new Set(repositories.filter((repo) => repo.isRegistered).map((repo) => repo.fullName.toLowerCase()));
  const openByContributor = pullRequests.filter(
    (pr) => pr.state === "open" && sameLogin(pr.authorLogin, login) && registered.has(pr.repoFullName.toLowerCase()),
  );

  const byRepo = groupByRepo(openByContributor);
  const pendingScenarios: ContributorOpenPrMonitor["pendingScenarios"] = [];
  const packets: ContributorOpenPrNextStepPacket[] = [];

  for (const [repoFullName, repoOpen] of byRepo.entries()) {
    const repo = repositories.find((entry) => entry.fullName.toLowerCase() === repoFullName.toLowerCase()) ?? null;
    const roleContext = buildRoleContext({
      login,
      repo,
      repoFullName,
      pullRequests,
      issues: [],
      profile: null,
    });
    const signals = await loadContributorRepoOpenPrSignals(env, repoFullName, repoOpen);
    const repoPullRequests = await listPullRequests(env, repoFullName);
    const duplicateNumbers = duplicatePronePullNumbers(repoOpen);

    for (const pr of repoOpen) {
      const reviews = signals.reviewsByPullNumber.get(pr.number) ?? [];
      const checks = signals.checksByPullNumber.get(pr.number) ?? [];
      const files = await listPullRequestFiles(env, repoFullName, pr.number);
      const classified = classifyOpenPullRequest({
        pr,
        roleContext,
        reviews,
        checks,
        duplicateProne: duplicateNumbers.has(pr.number),
        missingTests: missingTestsFromFiles(files),
      });
      packets.push(buildNextStepPacket(classified, reviews, checks, duplicateNumbers.has(pr.number), missingTestsFromFiles(files)));
    }

    const detection = detectPendingPrScenario({
      login,
      repoFullName,
      pullRequests: repoPullRequests,
      roleContext,
      openPrCount: repoOpen.length,
      reviewsByPullNumber: signals.reviewsByPullNumber,
      checksByPullNumber: signals.checksByPullNumber,
    });
    if (detection) pendingScenarios.push({ repoFullName, detection });
  }

  packets.sort((left, right) => priorityRank(left.classification) - priorityRank(right.classification) || left.repoFullName.localeCompare(right.repoFullName) || left.number - right.number);

  const cleanupFirst = packets.some((entry) =>
    ["needs_author", "failing_checks", "duplicate_prone", "stale", "should_close_or_withdraw", "blocked"].includes(entry.classification),
  );
  const approvedCount = packets.filter((entry) => entry.classification === "approved").length;
  const summary = summarizeMonitor(openByContributor.length, approvedCount, cleanupFirst);
  const guidance = buildMonitorGuidance(packets, cleanupFirst);

  return {
    login,
    generatedAt: nowIso(),
    openPrCount: openByContributor.length,
    registeredRepoCount: registered.size,
    cleanupFirst,
    summary: sanitizePublicComment(summary),
    guidance: guidance.map((line) => sanitizePublicComment(line)),
    pendingScenarios,
    pullRequests: packets,
  };
}

export function mapPendingClassToWorkClassification(
  classified: ClassifiedOpenPullRequest,
  args: { changeRequestCount: number; checkFailureCount: number; duplicateProne: boolean; missingTests: boolean },
): OpenPrWorkClassification {
  if (classified.classification === "maintainer_lane") return "maintainer_lane";
  if (classified.classification === "draft") return "draft";
  if (classified.classification === "stale_likely_close") return "should_close_or_withdraw";
  if (args.duplicateProne) return "duplicate_prone";
  if (args.checkFailureCount > 0) return "failing_checks";
  if (args.changeRequestCount > 0) return "needs_author";
  if (args.missingTests) return "missing_tests";
  if (classified.classification === "merge_ready") return "approved";
  if (classified.classification === "blocked") return "blocked";
  return "reviewable";
}

function buildNextStepPacket(
  classified: ClassifiedOpenPullRequest,
  reviews: PullRequestReviewRecord[],
  checks: CheckSummaryRecord[],
  duplicateProne: boolean,
  missingTests: boolean,
): ContributorOpenPrNextStepPacket {
  const changeRequestCount = reviews.filter((review) => review.state.toUpperCase() === "CHANGES_REQUESTED").length;
  const checkFailureCount = checks.filter((check) => check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "cancelled").length;
  const classification = mapPendingClassToWorkClassification(classified, { changeRequestCount, checkFailureCount, duplicateProne, missingTests });
  const nextSteps = nextStepsForClassification(classification, classified.repoFullName, classified.number);
  const summary = `${classified.repoFullName}#${classified.number}: ${classification.replace(/_/g, " ")} — ${classified.title}`;
  return {
    repoFullName: classified.repoFullName,
    number: classified.number,
    title: classified.title,
    classification,
    summary: sanitizePublicComment(summary),
    reasons: classified.reasons.map((reason) => sanitizePublicComment(reason)),
    nextSteps: nextSteps.map((step) => sanitizePublicComment(step)),
  };
}

function nextStepsForClassification(classification: OpenPrWorkClassification, repoFullName: string, number: number): string[] {
  const ref = `${repoFullName}#${number}`;
  switch (classification) {
    case "approved":
      return [`Confirm CI is green on ${ref}, then nudge maintainers or wait for merge.`, `Avoid opening new PRs in this repo until ${ref} lands or you close it.`];
    case "failing_checks":
      return [`Fix failing checks on ${ref} before requesting another review.`, `Re-run CI after pushing fixes; do not open parallel PRs for the same fix.`];
    case "needs_author":
      return [`Address review comments on ${ref} and push updates.`, `Reply on the PR thread summarizing what changed.`];
    case "missing_tests":
      return [`Add or update tests on ${ref} if the repo expects test coverage.`, `Note test commands run in the PR description.`];
    case "duplicate_prone":
      return [`Check overlap with other open PRs in ${repoFullName}; close or consolidate duplicates.`, `Comment on ${ref} linking the canonical PR if one exists.`];
    case "stale":
    case "should_close_or_withdraw":
      return [`Update ${ref} with a short status comment or close it if no longer needed.`, `Do not open new work until stale queue pressure is reduced.`];
    case "maintainer_lane":
      return [`Treat ${ref} as maintainer/repo-owner work, not normal outside-contributor mining evidence.`, `Focus on repo health, intake quality, or maintainer-cut readiness instead of score chasing.`];
    case "draft":
      return [`Mark ${ref} ready for review when complete, or close the draft.`, `Ensure linked issues and test plan are filled before undrafting.`];
    case "reviewable":
      return [`Polish ${ref} description, link issues, and confirm lane fit before pinging reviewers.`, `Keep only one active PR per narrow topic in ${repoFullName}.`];
    case "blocked":
    default:
      return [`Resolve blockers on ${ref} (reviews, checks, or missing context) before expanding scope.`, `Run local preflight again after updates.`];
  }
}

function summarizeMonitor(openCount: number, approvedCount: number, cleanupFirst: boolean): string {
  if (openCount === 0) return "No open pull requests on registered repos in cache.";
  if (cleanupFirst) {
    return `${openCount} open PR(s) across registered repos; clean up existing work before opening more (${approvedCount} look merge-ready).`;
  }
  return `${openCount} open PR(s) across registered repos; ${approvedCount} look merge-ready from cached metadata.`;
}

function buildMonitorGuidance(packets: ContributorOpenPrNextStepPacket[], cleanupFirst: boolean): string[] {
  const lines: string[] = [];
  if (cleanupFirst) lines.push("Prioritize existing open PRs before starting new issues or branches.");
  const failing = packets.filter((entry) => entry.classification === "failing_checks").length;
  const needsAuthor = packets.filter((entry) => entry.classification === "needs_author").length;
  const duplicate = packets.filter((entry) => entry.classification === "duplicate_prone").length;
  if (failing > 0) lines.push(`${failing} PR(s) need failing checks addressed first.`);
  if (needsAuthor > 0) lines.push(`${needsAuthor} PR(s) need author follow-up on review comments.`);
  if (duplicate > 0) lines.push(`${duplicate} PR(s) look duplicate-prone; consolidate before adding more queue load.`);
  if (packets.some((entry) => entry.classification === "approved")) {
    lines.push("Merge-ready PRs can improve pending-merge score projections after they land.");
  }
  if (lines.length === 0) lines.push("Queue looks manageable from cached metadata; still run preflight before new PRs.");
  return lines;
}

function groupByRepo(pullRequests: PullRequestRecord[]): Map<string, PullRequestRecord[]> {
  const map = new Map<string, PullRequestRecord[]>();
  for (const pr of pullRequests) {
    const bucket = map.get(pr.repoFullName) ?? [];
    bucket.push(pr);
    map.set(pr.repoFullName, bucket);
  }
  return map;
}

function duplicatePronePullNumbers(openPullRequests: PullRequestRecord[]): Set<number> {
  const flagged = new Set<number>();
  const byNormalizedTitle = new Map<string, PullRequestRecord[]>();
  for (const pr of openPullRequests) {
    const key = normalizeTitle(pr.title);
    const bucket = byNormalizedTitle.get(key) ?? [];
    bucket.push(pr);
    byNormalizedTitle.set(key, bucket);
  }
  for (const bucket of byNormalizedTitle.values()) {
    if (bucket.length < 2) continue;
    for (const pr of bucket) flagged.add(pr.number);
  }
  const wip = openPullRequests.filter((pr) => pr.labels.some((label) => /^(wip|duplicate)$/i.test(label)));
  for (const pr of wip) flagged.add(pr.number);
  return flagged;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^\[?\s*draft\s*\]?\s*/i, "")
    .replace(/^wip:\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function missingTestsFromFiles(files: PullRequestFileRecord[]): boolean {
  if (files.length === 0) return false;
  const codeFiles = files.filter((file) => file.path && !isTestPath(file.path));
  const testFiles = files.filter((file) => file.path && isTestPath(file.path));
  return codeFiles.length > 0 && testFiles.length === 0;
}

function priorityRank(classification: OpenPrWorkClassification): number {
  const order: OpenPrWorkClassification[] = [
    "failing_checks",
    "needs_author",
    "duplicate_prone",
    "missing_tests",
    "blocked",
    "should_close_or_withdraw",
    "stale",
    "draft",
    "reviewable",
    "approved",
    "maintainer_lane",
  ];
  const index = order.indexOf(classification);
  return index === -1 ? order.length : index;
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return Boolean(value && value.toLowerCase() === login.toLowerCase());
}

export const __contributorOpenPrMonitorInternals = {
  mapPendingClassToWorkClassification,
  nextStepsForClassification,
  summarizeMonitor,
  buildMonitorGuidance,
  duplicatePronePullNumbers,
  missingTestsFromFiles,
  priorityRank,
  buildNextStepPacket,
};
