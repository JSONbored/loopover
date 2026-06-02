import { describe, expect, it } from "vitest";
import {
  buildContributorEvidenceGraph,
  CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS,
  CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS,
  CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS,
  evidenceGraphTouchedRepoFullNames,
} from "../../src/services/contributor-evidence-graph";
import type { PullRequestFileRecord, PullRequestRecord, RepositoryRecord } from "../../src/types";

const GENERATED_AT = "2026-05-28T00:00:00.000Z";
const FRESH_AT = "2026-05-27T00:00:00.000Z";
const STALE_AT = "2026-04-01T00:00:00.000Z";
const FORBIDDEN_PUBLIC_TERMS = /wallet|hotkey|raw trust score|payout|reward estimate|farming|private reviewability|public score estimate/i;

function repo(fullName: string): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: {
      repo: fullName,
      emissionShare: 0.02,
      issueDiscoveryShare: 0,
      labelMultipliers: {},
      trustedLabelPipeline: false,
      maintainerCut: 0,
      raw: {},
    },
  };
}

function pr(repoFullName: string, number: number, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    repoFullName,
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "dev",
    authorAssociation: "CONTRIBUTOR",
    labels: [],
    linkedIssues: [],
    createdAt: FRESH_AT,
    updatedAt: FRESH_AT,
    ...overrides,
  };
}

function file(repoFullName: string, pullNumber: number, path: string): PullRequestFileRecord {
  return { repoFullName, pullNumber, path, additions: 5, deletions: 1, changes: 6, payload: {} };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    login: "dev",
    generatedAt: GENERATED_AT,
    github: { login: "dev", topLanguages: ["TypeScript"], source: "github" },
    source: "github_cache",
    registeredRepoActivity: { pullRequests: 0, mergedPullRequests: 0, issues: 0, reposTouched: [], dominantLabels: [] },
    trustSignals: { evidenceScore: 0, level: "new", unlinkedOpenPullRequests: 0, maintainerAssociatedPullRequests: 0 },
    ...overrides,
  } as any;
}

function outcome(repoFullName: string, overrides: Record<string, unknown> = {}) {
  return {
    repoFullName,
    role: "outside_contributor",
    lane: "direct_pr",
    maintainerLane: false,
    pullRequests: 1,
    mergedPullRequests: 0,
    openPullRequests: 1,
    closedPullRequests: 0,
    closedPullRequestRate: 0,
    issues: 0,
    openIssues: 0,
    closedIssues: 0,
    solvedIssues: 0,
    validSolvedIssues: 0,
    credibility: 1,
    issueCredibility: 1,
    isEligible: false,
    successLevel: "emerging",
    strengths: [],
    risks: [],
    ...overrides,
  } as any;
}

function history(repoOutcomes: any[]) {
  return {
    login: "dev",
    generatedAt: GENERATED_AT,
    source: "github_cache",
    totals: {},
    repoOutcomes,
    successPatterns: [],
    failurePatterns: [],
    summary: "fixture",
  } as any;
}

function role(repoFullName: string, overrides: Record<string, unknown> = {}) {
  return {
    login: "dev",
    repoFullName,
    generatedAt: GENERATED_AT,
    role: "outside_contributor",
    maintainerLane: false,
    normalContributorEvidenceAllowed: true,
    source: "cache",
    reasons: [],
    guidance: "Use contributor-lane guidance.",
    ...overrides,
  } as any;
}

describe("contributor evidence graph", () => {
  it("prefers official Gittensor evidence, then mirror labels, then cached paths", () => {
    const repoFullName = "owner/direct";
    const gittensorSnapshot = {
      updatedAt: FRESH_AT,
      evaluatedAt: FRESH_AT,
      hotkey: "secret-key-material",
      issueMirrorAvailable: true,
      repositories: [
        {
          repoFullName,
          pullRequests: 10,
          mergedPullRequests: 8,
          openPullRequests: 1,
          closedPullRequests: 1,
          openIssues: 1,
          closedIssues: 2,
          solvedIssues: 2,
          validSolvedIssues: 1,
        },
      ],
      pullRequests: [{ repoFullName, number: 7, title: "Official", state: "MERGED", mergedAt: FRESH_AT, label: "feature", score: 1, baseScore: 1, tokenScore: 1 }],
      issues: [{ repoFullName, number: 9, state: "closed", solvedByPullRequest: 7, labels: ["bug"] }],
      issueLabels: ["bug"],
      totals: {},
    } as any;
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        source: "gittensor_api",
        gittensor: {
          updatedAt: FRESH_AT,
          evaluatedAt: FRESH_AT,
          hotkey: "secret-key-material",
          repositories: gittensorSnapshot.repositories,
          totals: {},
        },
        registeredRepoActivity: { pullRequests: 10, mergedPullRequests: 8, issues: 3, reposTouched: [repoFullName], dominantLabels: ["feature"] },
      }),
      outcomeHistory: history([outcome(repoFullName, { pullRequests: 10, mergedPullRequests: 8, openPullRequests: 1, closedPullRequests: 1, issues: 3, solvedIssues: 2, validSolvedIssues: 1 })]),
      roleContexts: [role(repoFullName, { source: "gittensor_api" })],
      repositories: [repo(repoFullName)],
      pullRequests: [pr(repoFullName, 7, { state: "merged", mergedAt: FRESH_AT, labels: ["cached-only"] })],
      issues: [],
      repoStats: [{ login: "dev", repoFullName, pullRequests: 2, mergedPullRequests: 1, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["cached-only"], lastActivityAt: FRESH_AT }],
      pullRequestFiles: [file(repoFullName, 7, "src/direct.ts")],
      gittensorSnapshot,
    });

    expect(graph.sourcePreference).toEqual(["official_gittensor", "mirror", "github_cache"]);
    expect(graph.repos[0]).toMatchObject({ repoFullName, source: "official_gittensor", freshness: "fresh", pullRequests: 10, validSolvedIssues: 1 });
    expect(graph.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoFullName, label: "feature", source: "official_gittensor" }),
        expect.objectContaining({ repoFullName, label: "bug", source: "mirror" }),
      ]),
    );
    expect(graph.paths).toEqual([expect.objectContaining({ repoFullName, path: "src/direct.ts", source: "github_cache", mergedPullRequests: 1 })]);
    expect(graph.outcomes[0]).toMatchObject({ repoFullName, source: "official_gittensor", pullRequests: 10, mergedPullRequests: 8 });
    expect(JSON.stringify(graph)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("keeps maintainer-lane relationships out of outside-contributor totals", () => {
    const outsideRepo = "owner/direct";
    const maintainerRepo = "dev/owned";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({ registeredRepoActivity: { pullRequests: 11, mergedPullRequests: 7, issues: 0, reposTouched: [outsideRepo, maintainerRepo], dominantLabels: [] } }),
      outcomeHistory: history([
        outcome(outsideRepo, { pullRequests: 3, mergedPullRequests: 2, issues: 2, validSolvedIssues: 1 }),
        outcome(maintainerRepo, { role: "owner", maintainerLane: true, pullRequests: 8, mergedPullRequests: 5, issues: 7, validSolvedIssues: 4, successLevel: "maintainer_context" }),
      ]),
      roleContexts: [role(outsideRepo), role(maintainerRepo, { role: "owner", maintainerLane: true, normalContributorEvidenceAllowed: false, source: "repo_owner_match" })],
      repositories: [repo(outsideRepo), repo(maintainerRepo)],
      pullRequests: [
        pr(outsideRepo, 1, { state: "merged", mergedAt: FRESH_AT }),
        pr(maintainerRepo, 2, { authorAssociation: "OWNER", state: "merged", mergedAt: FRESH_AT }),
      ],
    });

    expect(graph.totals).toMatchObject({
      repositories: 2,
      outsideContributorRepositories: 1,
      maintainerLaneRepositories: 1,
      outsideContributorPullRequests: 3,
      maintainerLanePullRequests: 8,
      outsideContributorMergedPullRequests: 2,
      maintainerLaneMergedPullRequests: 5,
      issues: 9,
      outsideContributorIssues: 2,
      maintainerLaneIssues: 7,
      validSolvedIssues: 5,
      outsideContributorValidSolvedIssues: 1,
      maintainerLaneValidSolvedIssues: 4,
    });
    expect(graph.repos.find((entry) => entry.repoFullName === maintainerRepo)).toMatchObject({
      maintainerLane: true,
      normalContributorEvidenceAllowed: false,
    });
  });

  it("falls back to stale GitHub cache evidence when official sources are missing", () => {
    const repoFullName = "owner/stale";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({ registeredRepoActivity: { pullRequests: 1, mergedPullRequests: 0, issues: 1, reposTouched: [repoFullName], dominantLabels: ["bug"] } }),
      outcomeHistory: history([outcome(repoFullName, { pullRequests: 1, openPullRequests: 1, issues: 1 })]),
      roleContexts: [role(repoFullName)],
      repositories: [repo(repoFullName)],
      pullRequests: [pr(repoFullName, 1, { labels: ["bug"], updatedAt: STALE_AT, createdAt: STALE_AT })],
      issues: [{ repoFullName, number: 2, title: "Old report", state: "open", authorLogin: "dev", authorAssociation: "CONTRIBUTOR", labels: ["triage"], linkedPrs: [], createdAt: STALE_AT, updatedAt: STALE_AT }],
      repoStats: [{ login: "dev", repoFullName, pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 1, stalePullRequests: 1, unlinkedPullRequests: 0, dominantLabels: ["bug"], lastActivityAt: STALE_AT }],
    });

    expect(graph.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "official_gittensor", freshness: "missing", relationshipCount: 0 }),
        expect.objectContaining({ source: "github_cache", freshness: "stale" }),
      ]),
    );
    expect(graph.repos[0]).toMatchObject({ source: "github_cache", freshness: "stale" });
    expect(graph.labels.map((label) => label.freshness)).toContain("stale");
    expect(graph.totals.staleRelationships).toBeGreaterThan(0);
    expect(graph.warnings.join("\n")).toContain("Official Gittensor contributor snapshot is unavailable");
  });

  it("infers fallback roles and direct official counts when role snapshots are sparse", () => {
    const officialRepo = "dev/official";
    const outsideRepo = "owner/outside";
    const computedRepo = "dev/empty";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        source: "gittensor_api",
        gittensor: {
          updatedAt: FRESH_AT,
          evaluatedAt: FRESH_AT,
          repositories: [
            {
              repoFullName: officialRepo,
              pullRequests: 4,
              mergedPullRequests: 3,
              openPullRequests: 1,
              closedPullRequests: 0,
              openIssues: 2,
              closedIssues: 1,
              solvedIssues: 1,
              validSolvedIssues: 1,
            },
          ],
          totals: {},
        },
        registeredRepoActivity: { pullRequests: 5, mergedPullRequests: 3, issues: 3, reposTouched: [officialRepo, outsideRepo], dominantLabels: [] },
      }),
      outcomeHistory: history([]),
      roleContexts: [role(computedRepo, { role: "owner", maintainerLane: true, normalContributorEvidenceAllowed: false, source: "repo_owner_match" })],
      repositories: [repo(officialRepo), repo(outsideRepo), repo(computedRepo)],
      pullRequests: [pr(outsideRepo, 1, { state: "closed", authorAssociation: "NONE", labels: [] })],
      issues: [{ repoFullName: outsideRepo, number: 2, title: "Member-authored report", state: "open", authorLogin: "dev", authorAssociation: "MEMBER", labels: [], linkedPrs: [], createdAt: FRESH_AT, updatedAt: FRESH_AT }],
      gittensorSnapshot: {
        updatedAt: FRESH_AT,
        evaluatedAt: FRESH_AT,
        issueMirrorAvailable: false,
        repositories: [],
        pullRequests: [],
        issues: [],
        issueLabels: [],
        totals: {},
      } as any,
    });

    expect(graph.repos.find((entry) => entry.repoFullName === officialRepo)).toMatchObject({
      source: "official_gittensor",
      role: "repo_maintainer",
      maintainerLane: true,
      pullRequests: 4,
      issues: 3,
      validSolvedIssues: 1,
    });
    expect(graph.repos.find((entry) => entry.repoFullName === outsideRepo)).toMatchObject({
      source: "github_cache",
      role: "repo_maintainer",
      maintainerLane: true,
      pullRequests: 1,
      closedPullRequests: 1,
    });
    expect(graph.repos.find((entry) => entry.repoFullName === computedRepo)).toMatchObject({
      source: "computed",
      freshness: "fresh",
      maintainerLane: true,
      pullRequests: 0,
    });
    expect(graph.warnings).toContain("Gittensor issue mirror is unavailable; issue-label evidence falls back to GitHub cache.");
  });

  it("marks malformed cached timestamps as partial while keeping valid cache dates authoritative", () => {
    const leftBadRepo = "owner/left-bad";
    const rightBadRepo = "owner/right-bad";
    const partialRepo = "owner/partial-date";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        registeredRepoActivity: { pullRequests: 3, mergedPullRequests: 0, issues: 0, reposTouched: [leftBadRepo, rightBadRepo, partialRepo], dominantLabels: [] },
      }),
      outcomeHistory: history([]),
      roleContexts: [],
      repositories: [repo(leftBadRepo), repo(rightBadRepo), repo(partialRepo)],
      pullRequests: [
        pr(leftBadRepo, 1, { updatedAt: FRESH_AT }),
        pr(rightBadRepo, 2, { updatedAt: "not-a-date", createdAt: undefined }),
      ],
      repoStats: [
        { login: "dev", repoFullName: leftBadRepo, pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [], lastActivityAt: "not-a-date" },
        { login: "dev", repoFullName: rightBadRepo, pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [], lastActivityAt: FRESH_AT },
        { login: "dev", repoFullName: partialRepo, pullRequests: 1, mergedPullRequests: 0, openPullRequests: 1, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [], lastActivityAt: "not-a-date" },
      ],
    });

    expect(graph.repos.find((entry) => entry.repoFullName === leftBadRepo)).toMatchObject({ freshness: "fresh", source: "github_cache" });
    expect(graph.repos.find((entry) => entry.repoFullName === rightBadRepo)).toMatchObject({ freshness: "fresh", source: "github_cache" });
    expect(graph.repos.find((entry) => entry.repoFullName === partialRepo)).toMatchObject({ freshness: "partial", source: "github_cache" });
  });

  it("uses mirror-only repo evidence and issue-only GitHub timestamps", () => {
    const mirrorRepo = "owner/mirror-only";
    const issueOnlyRepo = "owner/issue-only";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        registeredRepoActivity: { pullRequests: 0, mergedPullRequests: 0, issues: 2, reposTouched: [issueOnlyRepo, ""], dominantLabels: [] },
      }),
      outcomeHistory: history([]),
      roleContexts: [],
      repositories: [repo(mirrorRepo), repo(issueOnlyRepo)],
      pullRequests: [pr(issueOnlyRepo, 3, { state: "merged", mergedAt: FRESH_AT, createdAt: undefined, updatedAt: undefined, labels: [""] })],
      issues: [{ repoFullName: issueOnlyRepo, number: 2, title: "Fresh issue", state: "open", authorLogin: "dev", authorAssociation: "CONTRIBUTOR", labels: ["help wanted", ""], linkedPrs: [], createdAt: FRESH_AT, updatedAt: undefined }],
      repoStats: [{ login: "someone-else", repoFullName: issueOnlyRepo, pullRequests: 9, mergedPullRequests: 9, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["ignored"] }],
      pullRequestFiles: [file(issueOnlyRepo, 999, "src/ignored.ts"), file(issueOnlyRepo, 3, "   "), file(issueOnlyRepo, 3, "src/from-merge.ts")],
      gittensorSnapshot: {
        issueMirrorAvailable: true,
        repositories: [],
        pullRequests: [],
        issues: [{ repoFullName: mirrorRepo, number: 1, state: "open", solvedByPullRequest: 7, labels: ["mirror-label"] }],
        issueLabels: ["mirror-label"],
        totals: {},
      } as any,
    });

    expect(graph.repos.find((entry) => entry.repoFullName === mirrorRepo)).toMatchObject({ source: "mirror", freshness: "partial", issues: 1, solvedIssues: 1, validSolvedIssues: 0 });
    expect(graph.labels.find((entry) => entry.repoFullName === mirrorRepo)).toMatchObject({ source: "mirror", freshness: "partial" });
    expect(graph.sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "mirror", freshness: "partial" })]));
    expect(graph.repos.find((entry) => entry.repoFullName === issueOnlyRepo)).toMatchObject({ source: "github_cache", freshness: "fresh", issues: 1 });
    expect(graph.paths).toEqual([expect.objectContaining({ repoFullName: issueOnlyRepo, path: "src/from-merge.ts", mergedPullRequests: 1 })]);
  });

  it("orders equal-weight cached labels and paths while using issue-only freshness", () => {
    const leftRepo = "owner/a";
    const rightRepo = "owner/b";
    const issueOnlyRepo = "owner/c";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        registeredRepoActivity: { pullRequests: 3, mergedPullRequests: 1, issues: 1, reposTouched: [leftRepo, rightRepo, issueOnlyRepo], dominantLabels: [] },
      }),
      outcomeHistory: history([]),
      roleContexts: [],
      repositories: [repo(leftRepo), repo(rightRepo), repo(issueOnlyRepo)],
      pullRequests: [
        pr(rightRepo, 2, { labels: ["tie"], authorAssociation: "COLLABORATOR" }),
        pr(leftRepo, 1, { state: "MERGED", labels: ["tie", "zeta", "alpha"], updatedAt: undefined, createdAt: undefined, mergedAt: FRESH_AT }),
      ],
      issues: [{ repoFullName: issueOnlyRepo, number: 3, title: "Issue-only", state: "open", authorLogin: "dev", authorAssociation: "CONTRIBUTOR", labels: ["issue"], linkedPrs: [], createdAt: undefined, updatedAt: FRESH_AT }],
      pullRequestFiles: [file(rightRepo, 2, "src/a.ts"), file(leftRepo, 1, "src/z.ts"), file(leftRepo, 1, "src/a.ts")],
    });

    expect(graph.labels.map((label) => `${label.repoFullName}:${label.label}`)).toEqual([
      "owner/a:alpha",
      "owner/a:tie",
      "owner/a:zeta",
      "owner/b:tie",
      "owner/c:issue",
    ]);
    expect(graph.paths.map((path) => `${path.repoFullName}:${path.path}:${path.mergedPullRequests}`)).toEqual([
      "owner/a:src/a.ts:1",
      "owner/a:src/z.ts:1",
      "owner/b:src/a.ts:0",
    ]);
    expect(graph.repos.find((entry) => entry.repoFullName === issueOnlyRepo)).toMatchObject({ source: "github_cache", freshness: "fresh", issues: 1 });
    expect(graph.repos.find((entry) => entry.repoFullName === rightRepo)).toMatchObject({ maintainerLane: true, normalContributorEvidenceAllowed: false });
  });

  it("orders graph relationships deterministically and applies worker-safe bounds", () => {
    const repoNames = Array.from({ length: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS + 5 }, (_, index) => `owner/repo-${String(index).padStart(2, "0")}`);
    const omittedRepo = repoNames[CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS + 1]!;
    const pullRequests = [
      ...repoNames.map((repoFullName, index) =>
        pr(repoFullName, index + 1, {
          labels: [`repo-label-${String(index).padStart(2, "0")}`],
          updatedAt: FRESH_AT,
        }),
      ),
      ...Array.from({ length: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS + 5 }, (_, index) =>
        pr(repoNames[0]!, index + 100, {
          labels: [`label-${String(index).padStart(3, "0")}`],
          updatedAt: FRESH_AT,
        }),
      ),
      pr(omittedRepo, 10_000, { labels: ["aaa-omitted"], updatedAt: FRESH_AT }),
      pr(omittedRepo, 10_001, { labels: ["aaa-omitted"], updatedAt: FRESH_AT }),
    ];
    const files = [
      ...Array.from({ length: CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS + 5 }, (_, index) => file(repoNames[0]!, 1, `src/path-${String(index).padStart(3, "0")}.ts`)),
      file(omittedRepo, 10_000, "src/aaa-omitted.ts"),
      file(omittedRepo, 10_001, "src/aaa-omitted.ts"),
    ];
    const args = {
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({
        registeredRepoActivity: { pullRequests: repoNames.length, mergedPullRequests: 0, issues: 0, reposTouched: [...repoNames].reverse(), dominantLabels: [] },
      }),
      outcomeHistory: history(repoNames.map((repoFullName) => outcome(repoFullName))),
      roleContexts: [...repoNames].reverse().map((repoFullName) => role(repoFullName)),
      repositories: [...repoNames].reverse().map((repoFullName) => repo(repoFullName)),
      pullRequests: [...pullRequests].reverse(),
      pullRequestFiles: [...files].reverse(),
    };

    const graphA = buildContributorEvidenceGraph(args);
    const graphB = buildContributorEvidenceGraph({ ...args, repositories: repoNames.map((repoFullName) => repo(repoFullName)), pullRequests, pullRequestFiles: files });

    expect(graphA.repos).toHaveLength(CONTRIBUTOR_EVIDENCE_GRAPH_MAX_REPOS);
    expect(graphA.labels).toHaveLength(CONTRIBUTOR_EVIDENCE_GRAPH_MAX_LABELS);
    expect(graphA.paths).toHaveLength(CONTRIBUTOR_EVIDENCE_GRAPH_MAX_PATHS);
    expect(graphA.repos.map((entry) => entry.repoFullName)).toEqual(graphB.repos.map((entry) => entry.repoFullName));
    expect(graphA.labels.map((entry) => `${entry.repoFullName}:${entry.label}`)).toEqual(graphB.labels.map((entry) => `${entry.repoFullName}:${entry.label}`));
    expect(graphA.paths.map((entry) => `${entry.repoFullName}:${entry.path}`)).toEqual(graphB.paths.map((entry) => `${entry.repoFullName}:${entry.path}`));
    const includedRepos = new Set(graphA.repos.map((entry) => entry.repoFullName));
    expect(graphA.labels.every((entry) => includedRepos.has(entry.repoFullName))).toBe(true);
    expect(graphA.paths.every((entry) => includedRepos.has(entry.repoFullName))).toBe(true);
    expect(graphA.labels.map((entry) => entry.label)).not.toContain("aaa-omitted");
    expect(graphA.paths.map((entry) => entry.path)).not.toContain("src/aaa-omitted.ts");
    expect(graphA.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("repo relationships capped"), expect.stringContaining("label relationships capped"), expect.stringContaining("path relationships capped")]),
    );
  });

  it("selects only registered touched repos for bounded path-cache loading", () => {
    expect(
      evidenceGraphTouchedRepoFullNames({
        login: "dev",
        profile: profile({ registeredRepoActivity: { pullRequests: 2, mergedPullRequests: 1, issues: 0, reposTouched: ["owner/registered", "owner/unregistered", ""], dominantLabels: [] } }),
        pullRequests: [pr("owner/registered", 1), pr("other/repo", 2, { authorLogin: "someone-else" })],
        issues: [{ repoFullName: "other/issue", number: 3, title: "Ignored issue", state: "open", authorLogin: "someone-else", authorAssociation: "CONTRIBUTOR", labels: [], linkedPrs: [], createdAt: FRESH_AT, updatedAt: FRESH_AT }],
        repoStats: [
          { login: "dev", repoFullName: "owner/stats", pullRequests: 1, mergedPullRequests: 1, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [] },
          { login: "someone-else", repoFullName: "owner/ignored-stats", pullRequests: 1, mergedPullRequests: 1, openPullRequests: 0, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: [] },
        ],
        repositories: [repo("owner/registered"), repo("owner/stats"), { ...repo("owner/unregistered"), isRegistered: false }],
      }),
    ).toEqual(["owner/registered", "owner/stats"]);
    expect(evidenceGraphTouchedRepoFullNames({ login: "dev" })).toEqual([]);
  });

  it("keeps missing cache timestamps partial without optional cache fields", () => {
    const repoFullName = "owner/missing-cache-dates";
    const graph = buildContributorEvidenceGraph({
      login: "dev",
      generatedAt: GENERATED_AT,
      profile: profile({ registeredRepoActivity: { pullRequests: 0, mergedPullRequests: 0, issues: 0, reposTouched: [repoFullName], dominantLabels: [] } }),
      outcomeHistory: history([]),
      roleContexts: [],
      repositories: [repo(repoFullName)],
      pullRequests: [pr(repoFullName, 4, { createdAt: undefined, updatedAt: undefined, mergedAt: undefined, authorAssociation: undefined, labels: ["cache"] })],
      issues: [
        {
          repoFullName,
          number: 5,
          title: "Issue missing optional cache fields",
          state: "open",
          authorLogin: "dev",
          authorAssociation: undefined,
          labels: undefined,
          linkedPrs: [],
          createdAt: undefined,
          updatedAt: undefined,
        } as any,
        {
          repoFullName,
          number: 6,
          title: "Issue with label but missing cache dates",
          state: "open",
          authorLogin: "dev",
          authorAssociation: "CONTRIBUTOR",
          labels: ["cache-issue"],
          linkedPrs: [],
          createdAt: undefined,
          updatedAt: undefined,
        },
      ],
      pullRequestFiles: [file(repoFullName, 4, "src/undated.ts")],
    });

    expect(graph.repos).toEqual([expect.objectContaining({ repoFullName, source: "github_cache", freshness: "partial" })]);
    expect(graph.labels).toEqual([
      expect.objectContaining({ repoFullName, label: "cache", freshness: "partial" }),
      expect.objectContaining({ repoFullName, label: "cache-issue", freshness: "partial" }),
    ]);
    expect(graph.paths).toEqual([expect.objectContaining({ repoFullName, path: "src/undated.ts", freshness: "partial" })]);
  });
});
