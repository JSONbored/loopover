import type { GittensorContributorSnapshot } from "../gittensor/api";
import type { ContributorOutcomeHistory, ContributorProfile, RoleContext } from "../signals/engine";
import type {
  ContributorRepoStatRecord,
  IssueRecord,
  PullRequestFileRecord,
  PullRequestRecord,
  RepositoryRecord,
  RepoSyncStateRecord,
} from "../types";
import { nowIso } from "../utils/json";

export const CONTRIBUTOR_EVIDENCE_GRAPH_SIGNAL = "contributor-evidence-graph";
export const CONTRIBUTOR_EVIDENCE_GRAPH_VERSION = 1;
export const CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS = 50;
export const CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS = 80;
export const CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS = 80;
export const CONTRIBUTOR_EVIDENCE_GRAPH_MAX_OUTCOMES = 50;

const OFFICIAL_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MIRROR_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const GITHUB_CACHE_STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const SOURCE_PRIORITY: Record<ContributorEvidenceGraphSourceKind, number> = {
  official_gittensor: 0,
  mirror: 1,
  github_cache: 2,
  computed: 3,
};

export type ContributorEvidenceGraphSourceKind = "official_gittensor" | "mirror" | "github_cache" | "computed";
export type ContributorEvidenceGraphFreshness = "fresh" | "stale" | "partial" | "missing";

export type ContributorEvidenceGraphProvenance = {
  source: ContributorEvidenceGraphSourceKind;
  freshness: ContributorEvidenceGraphFreshness;
  observedAt?: string | undefined;
  generatedAt: string;
  detail: string;
};

export type ContributorEvidenceGraphSource = ContributorEvidenceGraphProvenance & {
  relationshipCount: number;
};

export type ContributorEvidenceGraphRepo = {
  repoFullName: string;
  role: RoleContext["role"];
  lane: ContributorOutcomeHistory["repoOutcomes"][number]["lane"] | "unknown";
  maintainerLane: boolean;
  normalContributorEvidenceAllowed: boolean;
  source: ContributorEvidenceGraphSourceKind;
  freshness: ContributorEvidenceGraphFreshness;
  provenance: ContributorEvidenceGraphProvenance[];
  pullRequests: number;
  mergedPullRequests: number;
  openPullRequests: number;
  closedPullRequests: number;
  issues: number;
  solvedIssues: number;
  validSolvedIssues: number;
};

export type ContributorEvidenceGraphLabel = {
  repoFullName: string;
  label: string;
  pullRequests: number;
  issues: number;
  source: ContributorEvidenceGraphSourceKind;
  freshness: ContributorEvidenceGraphFreshness;
  provenance: ContributorEvidenceGraphProvenance;
};

export type ContributorEvidenceGraphPath = {
  repoFullName: string;
  path: string;
  pullRequests: number;
  mergedPullRequests: number;
  source: Extract<ContributorEvidenceGraphSourceKind, "github_cache">;
  freshness: ContributorEvidenceGraphFreshness;
  provenance: ContributorEvidenceGraphProvenance;
};

export type ContributorEvidenceGraphOutcome = {
  repoFullName: string;
  role: ContributorOutcomeHistory["repoOutcomes"][number]["role"];
  lane: ContributorOutcomeHistory["repoOutcomes"][number]["lane"];
  maintainerLane: boolean;
  source: ContributorEvidenceGraphSourceKind;
  freshness: ContributorEvidenceGraphFreshness;
  provenance: ContributorEvidenceGraphProvenance;
  pullRequests: number;
  mergedPullRequests: number;
  openPullRequests: number;
  closedPullRequests: number;
  issues: number;
  solvedIssues: number;
  validSolvedIssues: number;
  successLevel: ContributorOutcomeHistory["repoOutcomes"][number]["successLevel"];
};

export type ContributorEvidenceGraphTotals = {
  repositories: number;
  outsideContributorRepositories: number;
  maintainerLaneRepositories: number;
  pullRequests: number;
  outsideContributorPullRequests: number;
  maintainerLanePullRequests: number;
  mergedPullRequests: number;
  outsideContributorMergedPullRequests: number;
  maintainerLaneMergedPullRequests: number;
  issues: number;
  outsideContributorIssues: number;
  maintainerLaneIssues: number;
  validSolvedIssues: number;
  outsideContributorValidSolvedIssues: number;
  maintainerLaneValidSolvedIssues: number;
  labels: number;
  paths: number;
  outcomes: number;
  staleRelationships: number;
};

export type ContributorEvidenceGraph = {
  version: typeof CONTRIBUTOR_EVIDENCE_GRAPH_VERSION;
  login: string;
  generatedAt: string;
  sourcePreference: ["official_gittensor", "mirror", "github_cache"];
  bounds: {
    maxRepos: number;
    maxLabels: number;
    maxPaths: number;
    maxOutcomes: number;
  };
  sources: ContributorEvidenceGraphSource[];
  totals: ContributorEvidenceGraphTotals;
  repos: ContributorEvidenceGraphRepo[];
  labels: ContributorEvidenceGraphLabel[];
  paths: ContributorEvidenceGraphPath[];
  outcomes: ContributorEvidenceGraphOutcome[];
  warnings: string[];
  summary: string;
};

export type ContributorEvidenceGraphInput = {
  login: string;
  generatedAt?: string | undefined;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  roleContexts: RoleContext[];
  repositories: RepositoryRecord[];
  pullRequests?: PullRequestRecord[] | undefined;
  issues?: IssueRecord[] | undefined;
  repoStats?: ContributorRepoStatRecord[] | undefined;
  syncStates?: RepoSyncStateRecord[] | undefined;
  pullRequestFiles?: PullRequestFileRecord[] | undefined;
  gittensorSnapshot?: GittensorContributorSnapshot | null | undefined;
};

type EvidenceCounts = {
  pullRequests: number;
  mergedPullRequests: number;
  openPullRequests: number;
  closedPullRequests: number;
  issues: number;
  solvedIssues: number;
  validSolvedIssues: number;
};

type LabelBucket = {
  repoFullName: string;
  label: string;
  pullRequests: number;
  issues: number;
  source: ContributorEvidenceGraphSourceKind;
  observedAt?: string | undefined;
};

type PathBucket = {
  repoFullName: string;
  path: string;
  pullRequests: number;
  mergedPullRequests: number;
  observedAt?: string | undefined;
};

export function buildContributorEvidenceGraph(args: ContributorEvidenceGraphInput): ContributorEvidenceGraph {
  const generatedAt = args.generatedAt ?? nowIso();
  const repositoriesByKey = new Map(args.repositories.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const roleByRepo = new Map(args.roleContexts.map((role) => [role.repoFullName.toLowerCase(), role]));
  const outcomeByRepo = new Map(args.outcomeHistory.repoOutcomes.map((outcome) => [outcome.repoFullName.toLowerCase(), outcome]));
  const officialByRepo = new Map((args.profile.gittensor?.repositories ?? []).map((repo) => [repo.repoFullName.toLowerCase(), repo]));
  const repoStatsByRepo = new Map((args.repoStats ?? []).filter((stat) => sameLogin(stat.login, args.login)).map((stat) => [stat.repoFullName.toLowerCase(), stat]));
  const syncByRepo = new Map((args.syncStates ?? []).map((state) => [state.repoFullName.toLowerCase(), state]));
  const contributorPullRequests = (args.pullRequests ?? []).filter((pr) => sameLogin(pr.authorLogin, args.login));
  const contributorIssues = (args.issues ?? []).filter((issue) => sameLogin(issue.authorLogin, args.login));
  const mirrorIssues = args.gittensorSnapshot?.issues ?? [];
  const mirrorIssuesByRepo = new Map<string, NonNullable<GittensorContributorSnapshot["issues"]>>();
  for (const issue of mirrorIssues) {
    const key = issue.repoFullName.toLowerCase();
    const bucket = mirrorIssuesByRepo.get(key) ?? [];
    bucket.push(issue);
    mirrorIssuesByRepo.set(key, bucket);
  }

  const repoNamesByKey = new Map<string, string>();
  const addRepo = (repoFullName: string | null | undefined) => {
    if (!repoFullName) return;
    const key = repoFullName.toLowerCase();
    if (!repoNamesByKey.has(key)) repoNamesByKey.set(key, repoFullName);
  };
  for (const repoFullName of args.profile.registeredRepoActivity.reposTouched) addRepo(repoFullName);
  for (const stat of repoStatsByRepo.values()) addRepo(stat.repoFullName);
  for (const pr of contributorPullRequests) addRepo(pr.repoFullName);
  for (const issue of contributorIssues) addRepo(issue.repoFullName);
  for (const repo of args.profile.gittensor?.repositories ?? []) addRepo(repo.repoFullName);
  for (const pr of args.gittensorSnapshot?.pullRequests ?? []) addRepo(pr.repoFullName);
  for (const issue of mirrorIssues) addRepo(issue.repoFullName);
  for (const role of args.roleContexts) {
    if (role.maintainerLane || role.source !== "unknown") addRepo(role.repoFullName);
  }

  const allRepoNames = [...repoNamesByKey.values()].sort((left, right) => left.localeCompare(right));
  const repoNames = allRepoNames.slice(0, CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS);
  const reposCapped = allRepoNames.length > repoNames.length;

  const repoNodes = repoNames.map((repoFullName) => {
    const key = repoFullName.toLowerCase();
    const official = officialByRepo.get(key);
    const outcome = outcomeByRepo.get(key);
    const stat = repoStatsByRepo.get(key);
    const cachedPullRequests = contributorPullRequests.filter((pr) => sameRepo(pr.repoFullName, repoFullName));
    const cachedIssues = contributorIssues.filter((issue) => sameRepo(issue.repoFullName, repoFullName));
    const role =
      roleByRepo.get(key) ??
      fallbackRoleContext(args.login, repoFullName, outcome, repositoriesByKey.get(key), cachedPullRequests, cachedIssues, args.profile);
    const source = repoSource(official, mirrorIssuesByRepo.get(key), stat, cachedPullRequests, cachedIssues);
    const observedAt = observedAtForRepo(source, generatedAt, args.profile, args.gittensorSnapshot, stat, cachedPullRequests, cachedIssues, syncByRepo.get(key));
    const freshness = freshnessFor(source, observedAt, generatedAt);
    const counts = countsForRepo(outcome, official, mirrorIssuesByRepo.get(key), stat, cachedPullRequests, cachedIssues);
    return {
      repoFullName,
      role: role.role,
      lane: outcome?.lane ?? "unknown",
      maintainerLane: role.maintainerLane,
      normalContributorEvidenceAllowed: role.normalContributorEvidenceAllowed,
      source,
      freshness,
      provenance: [
        provenance(source, freshness, generatedAt, observedAt, provenanceDetailForSource(source)),
        ...(role.maintainerLane
          ? [provenance("computed", "fresh", generatedAt, generatedAt, "maintainer-lane relationship derived from repo ownership or cached author association")]
          : []),
      ],
      ...counts,
    } satisfies ContributorEvidenceGraphRepo;
  });

  const includedRepoKeys = new Set(repoNodes.map((repo) => repo.repoFullName.toLowerCase()));
  const allLabels = preferredLabelEdges(buildLabelBuckets(args, contributorPullRequests, contributorIssues), generatedAt).filter((label) => includedRepoKeys.has(label.repoFullName.toLowerCase()));
  const labels = allLabels.slice(0, CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS);
  const allPaths = buildPathEdges(args.login, contributorPullRequests, args.pullRequestFiles ?? [], generatedAt).filter((path) => includedRepoKeys.has(path.repoFullName.toLowerCase()));
  const paths = allPaths.slice(0, CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS);
  const allOutcomes = buildOutcomeEdges(args.outcomeHistory, repoNodes, generatedAt, args.profile, args.gittensorSnapshot, repoStatsByRepo, contributorPullRequests, contributorIssues);
  const outcomes = allOutcomes.slice(0, CONTRIBUTOR_EVIDENCE_GRAPH_MAX_OUTCOMES);

  const warnings = [
    ...(!args.profile.gittensor ? ["Official Gittensor contributor snapshot is unavailable; GitHub cache evidence is used where present."] : []),
    ...(args.profile.gittensor && args.gittensorSnapshot?.issueMirrorAvailable === false ? ["Gittensor issue mirror is unavailable; issue-label evidence falls back to GitHub cache."] : []),
    ...(reposCapped ? [`Evidence graph repo relationships capped at ${CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS}.`] : []),
    ...(labels.length < allLabels.length ? [`Evidence graph label relationships capped at ${CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS}.`] : []),
    ...(paths.length < allPaths.length ? [`Evidence graph path relationships capped at ${CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS}.`] : []),
  ];

  const sources = buildSources(generatedAt, args.profile, args.gittensorSnapshot, repoNodes, labels, paths, outcomes);
  const totals = buildTotals(repoNodes, labels, paths, outcomes);
  return {
    version: CONTRIBUTOR_EVIDENCE_GRAPH_VERSION,
    login: args.login,
    generatedAt,
    sourcePreference: ["official_gittensor", "mirror", "github_cache"],
    bounds: {
      maxRepos: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS,
      maxLabels: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS,
      maxPaths: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS,
      maxOutcomes: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_OUTCOMES,
    },
    sources,
    totals,
    repos: repoNodes,
    labels,
    paths,
    outcomes,
    warnings,
    summary: `${args.login} evidence graph has ${repoNodes.length} repo, ${paths.length} path, ${labels.length} label, and ${outcomes.length} outcome relationship(s).`,
  };
}

export function evidenceGraphTouchedRepoFullNames(args: {
  login: string;
  profile?: ContributorProfile | null | undefined;
  pullRequests?: PullRequestRecord[] | undefined;
  issues?: IssueRecord[] | undefined;
  repoStats?: ContributorRepoStatRecord[] | undefined;
  repositories?: RepositoryRecord[] | undefined;
}): string[] {
  const namesByKey = new Map<string, string>();
  const add = (repoFullName: string | null | undefined) => {
    if (!repoFullName) return;
    const key = repoFullName.toLowerCase();
    if (!namesByKey.has(key)) namesByKey.set(key, repoFullName);
  };
  for (const repoFullName of args.profile?.registeredRepoActivity.reposTouched ?? []) add(repoFullName);
  for (const repo of args.profile?.gittensor?.repositories ?? []) add(repo.repoFullName);
  for (const stat of args.repoStats ?? []) if (sameLogin(stat.login, args.login)) add(stat.repoFullName);
  for (const pr of args.pullRequests ?? []) if (sameLogin(pr.authorLogin, args.login)) add(pr.repoFullName);
  for (const issue of args.issues ?? []) if (sameLogin(issue.authorLogin, args.login)) add(issue.repoFullName);
  const registeredKeys = new Set((args.repositories ?? []).filter((repo) => repo.isRegistered).map((repo) => repo.fullName.toLowerCase()));
  return [...namesByKey.values()]
    .filter((repoFullName) => registeredKeys.size === 0 || registeredKeys.has(repoFullName.toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS);
}

function buildLabelBuckets(args: ContributorEvidenceGraphInput, contributorPullRequests: PullRequestRecord[], contributorIssues: IssueRecord[]): LabelBucket[] {
  const buckets = new Map<string, LabelBucket>();
  const add = (repoFullName: string, label: string | null | undefined, source: ContributorEvidenceGraphSourceKind, kind: "pull_request" | "issue", observedAt?: string | undefined) => {
    const normalized = label?.trim();
    if (!normalized) return;
    const key = `${repoFullName.toLowerCase()}\0${normalized.toLowerCase()}\0${source}`;
    const current = buckets.get(key) ?? { repoFullName, label: normalized, pullRequests: 0, issues: 0, source, observedAt };
    if (kind === "pull_request") current.pullRequests += 1;
    else current.issues += 1;
    current.observedAt = newestIso(current.observedAt, observedAt);
    buckets.set(key, current);
  };

  for (const pr of args.gittensorSnapshot?.pullRequests ?? []) add(pr.repoFullName, pr.label, "official_gittensor", "pull_request", args.gittensorSnapshot?.updatedAt ?? args.gittensorSnapshot?.evaluatedAt);
  for (const issue of args.gittensorSnapshot?.issues ?? []) for (const label of issue.labels) add(issue.repoFullName, label, "mirror", "issue", args.gittensorSnapshot?.updatedAt ?? args.gittensorSnapshot?.evaluatedAt);
  for (const pr of contributorPullRequests) for (const label of pr.labels ?? []) add(pr.repoFullName, label, "github_cache", "pull_request", pr.updatedAt ?? pr.createdAt ?? undefined);
  for (const issue of contributorIssues) for (const label of issue.labels ?? []) add(issue.repoFullName, label, "github_cache", "issue", issue.updatedAt ?? issue.createdAt ?? undefined);
  for (const stat of args.repoStats ?? []) {
    if (!sameLogin(stat.login, args.login)) continue;
    for (const label of stat.dominantLabels) add(stat.repoFullName, label, "github_cache", "pull_request", stat.lastActivityAt ?? undefined);
  }
  return [...buckets.values()];
}

function preferredLabelEdges(buckets: LabelBucket[], generatedAt: string): ContributorEvidenceGraphLabel[] {
  const byLabel = new Map<string, LabelBucket>();
  for (const bucket of buckets) {
    const key = `${bucket.repoFullName.toLowerCase()}\0${bucket.label.toLowerCase()}`;
    const current = byLabel.get(key);
    if (!current || SOURCE_PRIORITY[bucket.source] < SOURCE_PRIORITY[current.source]) byLabel.set(key, bucket);
  }
  return [...byLabel.values()]
    .map((bucket) => {
      const freshness = freshnessFor(bucket.source, bucket.observedAt, generatedAt);
      return {
        repoFullName: bucket.repoFullName,
        label: bucket.label,
        pullRequests: bucket.pullRequests,
        issues: bucket.issues,
        source: bucket.source,
        freshness,
        provenance: provenance(bucket.source, freshness, generatedAt, bucket.observedAt, `label relationship observed from ${sourceLabel(bucket.source)}`),
      };
    })
    .sort(
      (left, right) =>
        right.pullRequests + right.issues - (left.pullRequests + left.issues) ||
        left.repoFullName.localeCompare(right.repoFullName) ||
        left.label.localeCompare(right.label) ||
        SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source],
    );
}

function buildPathEdges(login: string, contributorPullRequests: PullRequestRecord[], files: PullRequestFileRecord[], generatedAt: string): ContributorEvidenceGraphPath[] {
  const prByKey = new Map(contributorPullRequests.filter((pr) => sameLogin(pr.authorLogin, login)).map((pr) => [`${pr.repoFullName.toLowerCase()}#${pr.number}`, pr]));
  const buckets = new Map<string, PathBucket>();
  for (const file of files) {
    const pr = prByKey.get(`${file.repoFullName.toLowerCase()}#${file.pullNumber}`);
    if (!pr) continue;
    const path = file.path.trim();
    if (!path) continue;
    const key = `${file.repoFullName.toLowerCase()}\0${path}`;
    const current = buckets.get(key) ?? { repoFullName: file.repoFullName, path, pullRequests: 0, mergedPullRequests: 0, observedAt: undefined };
    current.pullRequests += 1;
    if (pr.mergedAt || pr.state.toLowerCase() === "merged") current.mergedPullRequests += 1;
    current.observedAt = newestIso(current.observedAt, pr.updatedAt ?? pr.createdAt ?? pr.mergedAt ?? undefined);
    buckets.set(key, current);
  }
  return [...buckets.values()]
    .map((bucket) => {
      const freshness = freshnessFor("github_cache", bucket.observedAt, generatedAt);
      return {
        repoFullName: bucket.repoFullName,
        path: bucket.path,
        pullRequests: bucket.pullRequests,
        mergedPullRequests: bucket.mergedPullRequests,
        source: "github_cache" as const,
        freshness,
        provenance: provenance("github_cache", freshness, generatedAt, bucket.observedAt, "path relationship observed from cached pull-request file metadata"),
      };
    })
    .sort((left, right) => right.pullRequests - left.pullRequests || left.repoFullName.localeCompare(right.repoFullName) || left.path.localeCompare(right.path));
}

function buildOutcomeEdges(
  outcomeHistory: ContributorOutcomeHistory,
  repoNodes: ContributorEvidenceGraphRepo[],
  generatedAt: string,
  profile: ContributorProfile,
  gittensorSnapshot: GittensorContributorSnapshot | null | undefined,
  repoStatsByRepo: Map<string, ContributorRepoStatRecord>,
  contributorPullRequests: PullRequestRecord[],
  contributorIssues: IssueRecord[],
): ContributorEvidenceGraphOutcome[] {
  const repoByKey = new Map(repoNodes.map((repo) => [repo.repoFullName.toLowerCase(), repo]));
  return outcomeHistory.repoOutcomes
    .filter((outcome) => repoByKey.has(outcome.repoFullName.toLowerCase()))
    .map((outcome) => {
      const key = outcome.repoFullName.toLowerCase();
      const source = repoByKey.get(key)!.source;
      const observedAt = observedAtForRepo(
        source,
        generatedAt,
        profile,
        gittensorSnapshot,
        repoStatsByRepo.get(key),
        contributorPullRequests.filter((pr) => sameRepo(pr.repoFullName, outcome.repoFullName)),
        contributorIssues.filter((issue) => sameRepo(issue.repoFullName, outcome.repoFullName)),
      );
      const freshness = freshnessFor(source, observedAt, generatedAt);
      return {
        repoFullName: outcome.repoFullName,
        role: outcome.role,
        lane: outcome.lane,
        maintainerLane: outcome.maintainerLane,
        source,
        freshness,
        provenance: provenance(source, freshness, generatedAt, observedAt, `outcome relationship computed from ${sourceLabel(source)} evidence`),
        pullRequests: outcome.pullRequests,
        mergedPullRequests: outcome.mergedPullRequests,
        openPullRequests: outcome.openPullRequests,
        closedPullRequests: outcome.closedPullRequests,
        issues: outcome.issues,
        solvedIssues: outcome.solvedIssues,
        validSolvedIssues: outcome.validSolvedIssues,
        successLevel: outcome.successLevel,
      };
    })
    .sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
}

function fallbackRoleContext(
  login: string,
  repoFullName: string,
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
  repo: RepositoryRecord | undefined,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
  profile: ContributorProfile,
): RoleContext {
  const maintainerLane = Boolean(outcome?.maintainerLane) || sameLogin(repo?.owner, login) || maintainerAssociationVisible(pullRequests, issues);
  const role = outcome?.role ?? (maintainerLane ? "repo_maintainer" : "outside_contributor");
  return {
    login,
    repoFullName,
    generatedAt: nowIso(),
    role,
    maintainerLane,
    normalContributorEvidenceAllowed: !maintainerLane,
    source: profile.source === "gittensor_api" ? "gittensor_api" : "cache",
    reasons: maintainerLane ? ["Maintainer-lane relationship inferred from available outcome evidence."] : ["Contributor relationship inferred from available repo evidence."],
    guidance: maintainerLane
      ? "Use maintainer-lane guidance; do not count this repo as normal contributor evidence."
      : "Use contributor-lane guidance.",
  };
}

function maintainerAssociationVisible(pullRequests: PullRequestRecord[], issues: IssueRecord[]): boolean {
  return [...pullRequests.map((pr) => pr.authorAssociation), ...issues.map((issue) => issue.authorAssociation)].some((association) =>
    ["OWNER", "MEMBER", "COLLABORATOR"].includes((association ?? "").toUpperCase()),
  );
}

function repoSource(
  official: NonNullable<ContributorProfile["gittensor"]>["repositories"][number] | undefined,
  mirrorIssues: NonNullable<GittensorContributorSnapshot["issues"]> | undefined,
  stat: ContributorRepoStatRecord | undefined,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
): ContributorEvidenceGraphSourceKind {
  if (official) return "official_gittensor";
  if ((mirrorIssues?.length ?? 0) > 0) return "mirror";
  if (stat || pullRequests.length > 0 || issues.length > 0) return "github_cache";
  return "computed";
}

function countsForRepo(
  outcome: ContributorOutcomeHistory["repoOutcomes"][number] | undefined,
  official: NonNullable<ContributorProfile["gittensor"]>["repositories"][number] | undefined,
  mirrorIssues: NonNullable<GittensorContributorSnapshot["issues"]> | undefined,
  stat: ContributorRepoStatRecord | undefined,
  pullRequests: PullRequestRecord[],
  issues: IssueRecord[],
): EvidenceCounts {
  if (outcome) {
    return {
      pullRequests: outcome.pullRequests,
      mergedPullRequests: outcome.mergedPullRequests,
      openPullRequests: outcome.openPullRequests,
      closedPullRequests: outcome.closedPullRequests,
      issues: outcome.issues,
      solvedIssues: outcome.solvedIssues,
      validSolvedIssues: outcome.validSolvedIssues,
    };
  }
  if (official) {
    return {
      pullRequests: official.pullRequests,
      mergedPullRequests: official.mergedPullRequests,
      openPullRequests: official.openPullRequests,
      closedPullRequests: official.closedPullRequests,
      issues: official.openIssues + official.closedIssues,
      solvedIssues: official.solvedIssues,
      validSolvedIssues: official.validSolvedIssues,
    };
  }
  if (mirrorIssues && mirrorIssues.length > 0) {
    const solvedIssues = mirrorIssues.filter((issue) => issue.solvedByPullRequest).length;
    return {
      pullRequests: 0,
      mergedPullRequests: 0,
      openPullRequests: 0,
      closedPullRequests: 0,
      issues: mirrorIssues.length,
      solvedIssues,
      validSolvedIssues: 0,
    };
  }
  const mergedPullRequests = stat?.mergedPullRequests ?? pullRequests.filter((pr) => pr.mergedAt || pr.state.toLowerCase() === "merged").length;
  const openPullRequests = stat?.openPullRequests ?? pullRequests.filter((pr) => pr.state.toLowerCase() === "open").length;
  const pullRequestCount = stat?.pullRequests ?? pullRequests.length;
  return {
    pullRequests: pullRequestCount,
    mergedPullRequests,
    openPullRequests,
    closedPullRequests: Math.max(pullRequestCount - mergedPullRequests - openPullRequests, 0),
    issues: stat?.issues ?? issues.length,
    solvedIssues: 0,
    validSolvedIssues: 0,
  };
}

function observedAtForRepo(
  source: ContributorEvidenceGraphSourceKind,
  generatedAt: string,
  profile: ContributorProfile,
  gittensorSnapshot: GittensorContributorSnapshot | null | undefined,
  stat?: ContributorRepoStatRecord | undefined,
  pullRequests: PullRequestRecord[] = [],
  issues: IssueRecord[] = [],
  syncState?: RepoSyncStateRecord | undefined,
): string | undefined {
  if (source === "official_gittensor" || source === "mirror") return gittensorSnapshot?.updatedAt ?? gittensorSnapshot?.evaluatedAt ?? profile.gittensor?.updatedAt ?? profile.gittensor?.evaluatedAt;
  if (source === "computed") return generatedAt;
  return newestIso(
    stat?.lastActivityAt ?? undefined,
    newestIso(
      newestIso(syncState?.pullRequestsSyncedAt ?? syncState?.lastCompletedAt ?? syncState?.updatedAt ?? undefined, syncState?.issuesSyncedAt ?? undefined),
      newestIso(
        pullRequests.map((pr) => pr.updatedAt ?? pr.createdAt ?? pr.mergedAt ?? undefined).reduce((latest, date) => newestIso(latest, date), undefined as string | undefined),
        issues.map((issue) => issue.updatedAt ?? issue.createdAt ?? undefined).reduce((latest, date) => newestIso(latest, date), undefined as string | undefined),
      ),
    ),
  );
}

function provenance(
  source: ContributorEvidenceGraphSourceKind,
  freshness: ContributorEvidenceGraphFreshness,
  generatedAt: string,
  observedAt: string | undefined,
  detail: string,
): ContributorEvidenceGraphProvenance {
  return {
    source,
    freshness,
    generatedAt,
    ...(observedAt ? { observedAt } : {}),
    detail,
  };
}

function provenanceDetailForSource(source: ContributorEvidenceGraphSourceKind): string {
  if (source === "official_gittensor") return "repo relationship observed from official Gittensor contributor data";
  if (source === "mirror") return "repo relationship observed from Gittensor issue mirror data";
  if (source === "github_cache") return "repo relationship observed from cached GitHub contributor data";
  return "repo relationship derived from computed role or outcome context";
}

function buildSources(
  generatedAt: string,
  profile: ContributorProfile,
  gittensorSnapshot: GittensorContributorSnapshot | null | undefined,
  repos: ContributorEvidenceGraphRepo[],
  labels: ContributorEvidenceGraphLabel[],
  paths: ContributorEvidenceGraphPath[],
  outcomes: ContributorEvidenceGraphOutcome[],
): ContributorEvidenceGraphSource[] {
  const relationshipCounts = new Map<ContributorEvidenceGraphSourceKind, number>();
  for (const source of ["official_gittensor", "mirror", "github_cache", "computed"] as const) relationshipCounts.set(source, 0);
  for (const relation of [...repos, ...labels, ...paths, ...outcomes]) relationshipCounts.set(relation.source, relationshipCounts.get(relation.source)! + 1);
  const officialObservedAt = gittensorSnapshot?.updatedAt ?? gittensorSnapshot?.evaluatedAt ?? profile.gittensor?.updatedAt ?? profile.gittensor?.evaluatedAt;
  const githubRelations = [...repos, ...labels, ...paths, ...outcomes].filter((relation) => relation.source === "github_cache");
  const githubObservedAt = githubRelations.map((relation) => relationObservedAt(relation)).reduce((latest, date) => newestIso(latest, date), undefined as string | undefined);
  return [
    {
      ...provenance("official_gittensor", profile.gittensor ? freshnessFor("official_gittensor", officialObservedAt, generatedAt) : "missing", generatedAt, officialObservedAt, "official Gittensor contributor source"),
      relationshipCount: relationshipCounts.get("official_gittensor")!,
    },
    {
      ...provenance(
        "mirror",
        gittensorSnapshot?.issueMirrorAvailable ? freshnessFor("mirror", officialObservedAt, generatedAt) : "missing",
        generatedAt,
        officialObservedAt,
        "Gittensor issue mirror source",
      ),
      relationshipCount: relationshipCounts.get("mirror")!,
    },
    {
      ...provenance(
        "github_cache",
        githubRelations.length > 0 ? freshnessFor("github_cache", githubObservedAt, generatedAt) : "missing",
        generatedAt,
        githubObservedAt,
        "cached GitHub source",
      ),
      relationshipCount: relationshipCounts.get("github_cache")!,
    },
  ];
}

function relationObservedAt(
  relation: ContributorEvidenceGraphRepo | ContributorEvidenceGraphLabel | ContributorEvidenceGraphPath | ContributorEvidenceGraphOutcome,
): string | undefined {
  if (Array.isArray(relation.provenance)) return relation.provenance.map((entry) => entry.observedAt).reduce((latest, date) => newestIso(latest, date), undefined as string | undefined);
  return relation.provenance.observedAt;
}

function buildTotals(
  repos: ContributorEvidenceGraphRepo[],
  labels: ContributorEvidenceGraphLabel[],
  paths: ContributorEvidenceGraphPath[],
  outcomes: ContributorEvidenceGraphOutcome[],
): ContributorEvidenceGraphTotals {
  const outside = repos.filter((repo) => repo.normalContributorEvidenceAllowed);
  const maintainer = repos.filter((repo) => repo.maintainerLane);
  const staleRelationships = [...repos, ...labels, ...paths, ...outcomes].filter((relation) => relation.freshness === "stale").length;
  return {
    repositories: repos.length,
    outsideContributorRepositories: outside.length,
    maintainerLaneRepositories: maintainer.length,
    pullRequests: sum(repos, (repo) => repo.pullRequests),
    outsideContributorPullRequests: sum(outside, (repo) => repo.pullRequests),
    maintainerLanePullRequests: sum(maintainer, (repo) => repo.pullRequests),
    mergedPullRequests: sum(repos, (repo) => repo.mergedPullRequests),
    outsideContributorMergedPullRequests: sum(outside, (repo) => repo.mergedPullRequests),
    maintainerLaneMergedPullRequests: sum(maintainer, (repo) => repo.mergedPullRequests),
    issues: sum(repos, (repo) => repo.issues),
    outsideContributorIssues: sum(outside, (repo) => repo.issues),
    maintainerLaneIssues: sum(maintainer, (repo) => repo.issues),
    validSolvedIssues: sum(repos, (repo) => repo.validSolvedIssues),
    outsideContributorValidSolvedIssues: sum(outside, (repo) => repo.validSolvedIssues),
    maintainerLaneValidSolvedIssues: sum(maintainer, (repo) => repo.validSolvedIssues),
    labels: labels.length,
    paths: paths.length,
    outcomes: outcomes.length,
    staleRelationships,
  };
}

function freshnessFor(source: ContributorEvidenceGraphSourceKind, observedAt: string | undefined, generatedAt: string): ContributorEvidenceGraphFreshness {
  if (!observedAt) return "partial";
  const observedMs = Date.parse(observedAt);
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(generatedMs)) return "partial";
  const ageMs = Math.max(0, generatedMs - observedMs);
  const staleAfterMs = source === "official_gittensor" ? OFFICIAL_STALE_AFTER_MS : source === "mirror" ? MIRROR_STALE_AFTER_MS : GITHUB_CACHE_STALE_AFTER_MS;
  return ageMs > staleAfterMs ? "stale" : "fresh";
}

function sourceLabel(source: ContributorEvidenceGraphSourceKind): string {
  if (source === "official_gittensor") return "official Gittensor";
  if (source === "mirror") return "Gittensor mirror";
  if (source === "github_cache") return "GitHub cache";
  /* v8 ignore next -- Labels are emitted only from official, mirror, or GitHub cache sources. */
  return "computed";
}

function sameLogin(value: string | null | undefined, login: string): boolean {
  return value?.toLowerCase() === login.toLowerCase();
}

function sameRepo(left: string | null | undefined, right: string | null | undefined): boolean {
  return left?.toLowerCase() === right?.toLowerCase();
}

function newestIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function sum<T>(items: T[], mapper: (item: T) => number): number {
  return items.reduce((total, item) => total + mapper(item), 0);
}
