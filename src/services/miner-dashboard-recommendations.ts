import type { ContributorDecisionPack } from "./decision-pack";
import type { SignalSnapshotRecord } from "../types";

export type MinerDashboardSignalGroup = "repo_state" | "contributor_state" | "validation_state" | "policy_context";
export type MinerDashboardChangeStatus = "new" | "changed" | "unchanged";

export type MinerDashboardChangeLabel = {
  kind: MinerDashboardSignalGroup;
  label: string;
  before?: string;
  after?: string;
};

export type MinerDashboardRecommendationChange = {
  status: MinerDashboardChangeStatus;
  summary: string;
  labels: MinerDashboardChangeLabel[];
};

export type MinerDashboardRerunReasonGroup = {
  group: MinerDashboardSignalGroup;
  title: string;
  reasons: string[];
};

export type MinerDashboardRecommendationMetadata = {
  change: MinerDashboardRecommendationChange;
  rerunReasons: MinerDashboardRerunReasonGroup[];
};

type DashboardRecord = Record<string, unknown>;

const GROUP_TITLES: Record<MinerDashboardSignalGroup, string> = {
  repo_state: "Repo state",
  contributor_state: "Contributor state",
  validation_state: "Validation state",
  policy_context: "Policy/context state",
};

const GROUP_ORDER: MinerDashboardSignalGroup[] = ["repo_state", "contributor_state", "validation_state", "policy_context"];
const CHANGE_LABEL_LIMIT = 6;
const REASON_LIMIT = 3;
const FORBIDDEN_PUBLIC_TEXT =
  /\b(wallets?|hotkeys?|coldkeys?|seed phrases?|mnemonics?|private keys?|raw[-_\s]?trust(?: scores?)?|trust[-_\s]?scores?|reward(?:[-_\s]?(?:estimate|prediction|claim|score))?s?|payouts?|farming(?:[-_\s]?language)?|private[-_\s]?reviewability|private[-_\s]?scoreability|scoreability|public[-_\s]?score[-_\s]?(?:estimate|prediction)|estimated[-_\s]?score|score[-_\s]?estimate)\b/gi;
const LOCAL_PATH = /(?:\/(?:Users|home|root|tmp|var)\/[^\s,;:)]+|[A-Za-z]:\\Users\\[^\s,;:)]+)/g;

export function previousDecisionPackFromSnapshots(currentPack: ContributorDecisionPack, snapshots: SignalSnapshotRecord[]): ContributorDecisionPack | undefined {
  const current = asRecord(currentPack);
  const currentGeneratedAt = stringValue(current, "generatedAt");
  for (const snapshot of snapshots) {
    const payload = asRecord(snapshot.payload);
    if (!payload || stringValue(payload, "status") !== "ready") continue;
    const generatedAt = stringValue(payload, "generatedAt") ?? snapshot.generatedAt;
    if (generatedAt && currentGeneratedAt && generatedAt === currentGeneratedAt) continue;
    return payload as unknown as ContributorDecisionPack;
  }
  return undefined;
}

export function buildMinerDashboardNextActions(
  pack: ContributorDecisionPack,
  previousPack?: ContributorDecisionPack,
): Array<DashboardRecord & MinerDashboardRecommendationMetadata> {
  const currentPack = asRecord(pack);
  const previous = asRecord(previousPack);
  const currentDecisions = repoRecordMap(recordArray(currentPack?.repoDecisions));
  const previousDecisions = repoRecordMap(recordArray(previous?.repoDecisions));
  const previousActions = actionRecordMaps(recordArray(previous?.topActions));
  const portfolio = portfolioRecordMaps(recordArray(asRecord(currentPack?.actionPortfolio)?.topActions));

  return recordArray(currentPack?.topActions).map((action) => {
    const repo = stringValue(action, "repoFullName");
    const currentDecision = repo ? currentDecisions.get(repo.toLowerCase()) : undefined;
    const previousAction = actionLookup(action, previousActions);
    const previousDecision = repo ? previousDecisions.get(repo.toLowerCase()) : undefined;
    return {
      ...action,
      change: buildRecommendationChange({
        current: action,
        currentDecision,
        currentPack,
        previous: previousAction,
        previousDecision,
        previousPack: previous,
      }),
      rerunReasons: buildRerunReasonGroups({
        current: action,
        currentDecision,
        currentPack,
        portfolioItem: portfolioLookup(action, portfolio),
      }),
    };
  });
}

export function buildMinerDashboardRepoFit(
  pack: ContributorDecisionPack,
  previousPack?: ContributorDecisionPack,
): Array<DashboardRecord & MinerDashboardRecommendationMetadata> {
  const currentPack = asRecord(pack);
  const previous = asRecord(previousPack);
  const currentRows = repoFitRows(currentPack);
  const previousRows = repoRecordMap(repoFitRows(previous));
  const currentDecisions = repoRecordMap(recordArray(currentPack?.repoDecisions));
  const previousDecisions = repoRecordMap(recordArray(previous?.repoDecisions));

  return currentRows.map((repo) => {
    const repoFullName = stringValue(repo, "repoFullName");
    const previousRow = repoFullName ? previousRows.get(repoFullName.toLowerCase()) : undefined;
    const currentDecision = repoFullName ? currentDecisions.get(repoFullName.toLowerCase()) ?? repo : repo;
    const previousDecision = repoFullName ? previousDecisions.get(repoFullName.toLowerCase()) ?? previousRow : previousRow;
    return {
      ...repo,
      change: buildRecommendationChange({
        current: repo,
        currentDecision,
        currentPack,
        previous: previousRow,
        previousDecision,
        previousPack: previous,
      }),
      rerunReasons: buildRerunReasonGroups({ current: repo, currentDecision, currentPack }),
    };
  });
}

function buildRecommendationChange(args: {
  current: DashboardRecord;
  currentDecision?: DashboardRecord | undefined;
  currentPack?: DashboardRecord | undefined;
  previous?: DashboardRecord | undefined;
  previousDecision?: DashboardRecord | undefined;
  previousPack?: DashboardRecord | undefined;
}): MinerDashboardRecommendationChange {
  const labels: MinerDashboardChangeLabel[] = [];
  const hasPrevious = Boolean(args.previous || args.previousDecision);
  if (!hasPrevious) {
    return {
      status: "new",
      summary: "New since the previous decision-pack run.",
      labels: [{ kind: "repo_state", label: "New recommendation" }],
    };
  }

  addChanged(labels, "repo_state", "Action changed", stringValue(args.previous, "actionKind"), stringValue(args.current, "actionKind"));
  addChanged(labels, "repo_state", "Lane changed", stringValue(args.previous, "lane"), stringValue(args.current, "lane"));
  addChanged(
    labels,
    "repo_state",
    "Recommendation changed",
    stringValue(args.previous, "recommendation") ?? stringValue(args.previousDecision, "recommendation"),
    stringValue(args.current, "recommendation") ?? stringValue(args.currentDecision, "recommendation"),
  );
  addChanged(
    labels,
    "repo_state",
    "Priority bucket changed",
    priorityBucket(numberValue(args.previous, "priorityScore") ?? numberValue(args.previousDecision, "priorityScore")),
    priorityBucket(numberValue(args.current, "priorityScore") ?? numberValue(args.currentDecision, "priorityScore")),
  );
  addChanged(labels, "repo_state", "Queue changed", queueSummary(args.previousDecision), queueSummary(args.currentDecision));
  addChanged(labels, "contributor_state", "Contributor PR state changed", outcomeSummary(args.previousDecision), outcomeSummary(args.currentDecision));
  addChanged(labels, "contributor_state", "Contributor lane changed", roleSummary(args.previousDecision), roleSummary(args.currentDecision));
  addChanged(labels, "validation_state", "Validation blockers changed", blockerSummary(args.previousDecision), blockerSummary(args.currentDecision));
  addChanged(labels, "policy_context", "Context freshness changed", packFidelityStatus(args.previousPack), packFidelityStatus(args.currentPack));
  addChanged(labels, "policy_context", "Repo policy changed", manifestSummary(args.previousDecision), manifestSummary(args.currentDecision));

  const limited = labels.slice(0, CHANGE_LABEL_LIMIT);
  if (labels.length === 0) {
    return { status: "unchanged", summary: "No tracked evidence changed since the previous run.", labels: [] };
  }

  const changedGroups = [...new Set(labels.map((label) => GROUP_TITLES[label.kind]))].join(", ");
  return {
    status: "changed",
    summary: `Changed since the previous run: ${changedGroups}.`,
    labels: limited,
  };
}

function buildRerunReasonGroups(args: {
  current: DashboardRecord;
  currentDecision?: DashboardRecord | undefined;
  currentPack?: DashboardRecord | undefined;
  portfolioItem?: DashboardRecord | undefined;
}): MinerDashboardRerunReasonGroup[] {
  const queue = queueNumbers(args.currentDecision);
  const blockers = blockerCodes(args.currentDecision);
  const portfolioReason = sanitizePublicText(stringValue(args.portfolioItem, "rerunWhen") ?? "");
  const policyReason = packFidelityStatus(args.currentPack) && packFidelityStatus(args.currentPack) !== "complete" && packFidelityStatus(args.currentPack) !== "ok"
    ? "Rerun after stale context refreshes or upstream policy data is rebuilt."
    : "Rerun when repo policy, focus manifest, upstream rules, or cached context changes.";

  const reasons: Record<MinerDashboardSignalGroup, string[]> = {
    repo_state: [
      portfolioReason && /pr|queue|registry|issue/i.test(portfolioReason)
        ? portfolioReason
        : "Rerun when open PRs, issue counts, or registry lane data change.",
      queue.openPullRequests > 0 || queue.openIssues > 0
        ? `Rerun after repo queue changes from ${queue.openPullRequests} open PR(s) and ${queue.openIssues} open issue(s).`
        : "Rerun when a new issue, PR, merge, or closure changes queue pressure.",
    ],
    contributor_state: [
      outcomeOpenPullRequests(args.currentDecision) > 0
        ? "Rerun after your existing PRs in this repo merge, close, or are updated."
        : "Rerun when contributor open work or recent outcomes change.",
      "Rerun when the selected contribution lane or cleanup-first preference changes.",
    ],
    validation_state: [
      blockers.length > 0
        ? `Rerun after validation blockers change: ${blockers.join(", ")}.`
        : "Rerun after local preflight, checks, or branch validation status changes.",
      "Rerun when branch freshness or linked-issue validation changes.",
    ],
    policy_context: [policyReason, "Rerun when issue-quality or repository policy evidence changes."],
  };

  return GROUP_ORDER.map((group) => ({
    group,
    title: GROUP_TITLES[group],
    reasons: uniqueStrings(reasons[group].map((reason) => sanitizePublicText(reason)).filter(Boolean)).slice(0, REASON_LIMIT),
  }));
}

function repoFitRows(pack: DashboardRecord | undefined): DashboardRecord[] {
  return [
    ...recordArray(pack?.pursueRepos).map((repo) => ({ ...repo, lane: "pursue" })),
    ...recordArray(pack?.cleanupFirst).map((repo) => ({ ...repo, lane: "cleanup-first" })),
    ...recordArray(pack?.maintainerLaneRepos).map((repo) => ({ ...repo, lane: "maintainer-lane" })),
    ...recordArray(pack?.avoidRepos).map((repo) => ({ ...repo, lane: "avoid" })),
  ];
}

function actionRecordMaps(actions: DashboardRecord[]): { byKey: Map<string, DashboardRecord>; byRepo: Map<string, DashboardRecord> } {
  const byKey = new Map<string, DashboardRecord>();
  const byRepo = new Map<string, DashboardRecord>();
  for (const action of actions) {
    const repo = stringValue(action, "repoFullName");
    const key = actionKey(action);
    if (key) byKey.set(key, action);
    if (repo && !byRepo.has(repo.toLowerCase())) byRepo.set(repo.toLowerCase(), action);
  }
  return { byKey, byRepo };
}

function actionLookup(action: DashboardRecord, maps: { byKey: Map<string, DashboardRecord>; byRepo: Map<string, DashboardRecord> }): DashboardRecord | undefined {
  const key = actionKey(action);
  const repo = stringValue(action, "repoFullName");
  return (key ? maps.byKey.get(key) : undefined) ?? (repo ? maps.byRepo.get(repo.toLowerCase()) : undefined);
}

function portfolioRecordMaps(items: DashboardRecord[]): { byKey: Map<string, DashboardRecord>; byRepo: Map<string, DashboardRecord> } {
  return actionRecordMaps(items);
}

function portfolioLookup(action: DashboardRecord, maps: { byKey: Map<string, DashboardRecord>; byRepo: Map<string, DashboardRecord> }): DashboardRecord | undefined {
  return actionLookup(action, maps);
}

function repoRecordMap(records: DashboardRecord[]): Map<string, DashboardRecord> {
  const map = new Map<string, DashboardRecord>();
  for (const record of records) {
    const repo = stringValue(record, "repoFullName");
    if (repo && !map.has(repo.toLowerCase())) map.set(repo.toLowerCase(), record);
  }
  return map;
}

function actionKey(action: DashboardRecord): string | undefined {
  const repo = stringValue(action, "repoFullName");
  const kind = stringValue(action, "actionKind");
  return repo && kind ? `${repo.toLowerCase()}:${kind}` : undefined;
}

function addChanged(
  labels: MinerDashboardChangeLabel[],
  kind: MinerDashboardSignalGroup,
  label: string,
  before: string | undefined,
  after: string | undefined,
): void {
  const safeBefore = sanitizePublicText(before ?? "");
  const safeAfter = sanitizePublicText(after ?? "");
  if (!safeBefore && !safeAfter) return;
  if (safeBefore === safeAfter) return;
  labels.push({
    kind,
    label,
    ...(safeBefore ? { before: safeBefore } : {}),
    ...(safeAfter ? { after: safeAfter } : {}),
  });
}

function priorityBucket(value: number | undefined): string | undefined {
  if (typeof value !== "number") return undefined;
  if (value >= 70) return "high";
  if (value >= 40) return "medium";
  if (value > 0) return "low";
  return "none";
}

function queueSummary(decision: DashboardRecord | undefined): string | undefined {
  const queue = queueNumbers(decision);
  if (!queue.present) return undefined;
  return `${queue.openPullRequests} PR / ${queue.openIssues} issue`;
}

function queueNumbers(decision: DashboardRecord | undefined): { present: boolean; openPullRequests: number; openIssues: number } {
  const queue = asRecord(decision?.queue);
  const openPullRequests = numberValue(queue, "openPullRequests") ?? 0;
  const openIssues = numberValue(queue, "openIssues") ?? 0;
  return { present: Boolean(queue), openPullRequests, openIssues };
}

function outcomeSummary(decision: DashboardRecord | undefined): string | undefined {
  const outcome = asRecord(decision?.outcome);
  if (!outcome) return undefined;
  const openPullRequests = numberValue(outcome, "openPullRequests") ?? 0;
  const mergedPullRequests = numberValue(outcome, "mergedPullRequests") ?? 0;
  const closedPullRequests = numberValue(outcome, "closedPullRequests") ?? 0;
  return `${openPullRequests} open / ${mergedPullRequests} merged / ${closedPullRequests} closed`;
}

function outcomeOpenPullRequests(decision: DashboardRecord | undefined): number {
  return numberValue(asRecord(decision?.outcome), "openPullRequests") ?? 0;
}

function roleSummary(decision: DashboardRecord | undefined): string | undefined {
  const role = asRecord(decision?.roleContext);
  if (!role) return undefined;
  const roleName = stringValue(role, "role") ?? stringValue(role, "lane") ?? "contributor";
  const maintainerLane = Boolean(role.maintainerLane);
  return `${roleName}${maintainerLane ? " maintainer-lane" : ""}`;
}

function blockerSummary(decision: DashboardRecord | undefined): string | undefined {
  const codes = blockerCodes(decision);
  return codes.length > 0 ? codes.join(", ") : "none";
}

function blockerCodes(decision: DashboardRecord | undefined): string[] {
  return recordArray(decision?.scoreBlockers)
    .map((blocker, index) => stringValue(blocker, "code") ?? `validation_${index + 1}`)
    .map((code) => sanitizePublicText(code))
    .filter(Boolean)
    .sort();
}

function packFidelityStatus(pack: DashboardRecord | undefined): string | undefined {
  const dataQuality = asRecord(pack?.dataQuality);
  const signalFidelity = asRecord(dataQuality?.signalFidelity);
  return stringValue(signalFidelity, "status");
}

function manifestSummary(decision: DashboardRecord | undefined): string | undefined {
  const manifest = asRecord(decision?.manifestSummary);
  if (!manifest) return undefined;
  const linkedIssuePolicy = stringValue(manifest, "linkedIssuePolicy") ?? "unknown";
  const issueDiscoveryPolicy = stringValue(manifest, "issueDiscoveryPolicy") ?? "unknown";
  const wantedPathCount = numberValue(manifest, "wantedPathCount") ?? 0;
  const blockedPathCount = numberValue(manifest, "blockedPathCount") ?? 0;
  return `${linkedIssuePolicy}/${issueDiscoveryPolicy}/${wantedPathCount} wanted/${blockedPathCount} blocked`;
}

function recordArray(value: unknown): DashboardRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is DashboardRecord => Boolean(entry)) : [];
}

function asRecord(value: unknown): DashboardRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DashboardRecord) : undefined;
}

function stringValue(record: DashboardRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(record: DashboardRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizePublicText(value: string): string {
  return value
    .replace(LOCAL_PATH, "[local path]")
    .replace(FORBIDDEN_PUBLIC_TEXT, "private context")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
