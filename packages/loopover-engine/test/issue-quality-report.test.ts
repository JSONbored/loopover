import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIssueQualityReport } from "../dist/index.js";

// The package-local twin of the host engine's buildIssueQualityReport (#6057) was reachable from the
// barrel but never invoked by this suite: `npm run engine:coverage` saw the module load (top-level
// constants only) and reported it BRF:0 with 96/313 lines, while the root vitest suite exercised it
// fully. Two uploads disagreeing about the same file is what surfaced as a phantom patch-coverage
// failure the moment a whole-file diff touched it (#9798). Cover it here, in the suite that actually
// grades this package, rather than leaning on the vitest duplicate.

type Json = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

const FIXTURE_NOW_MS = Date.now();

function daysAgoIso(days: number): string {
  return new Date(FIXTURE_NOW_MS - days * 86_400_000).toISOString();
}

function registryConfig(overrides: Json = {}): Json {
  return { repo: "acme/widgets", emissionShare: 1, issueDiscoveryShare: 0.5, labelMultipliers: {}, maintainerCut: 0, raw: {}, ...overrides };
}

function repo(fullName: string, overrides: Json = {}): Json {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    installationId: undefined,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    htmlUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    registryConfig: registryConfig({ repo: fullName }),
    ...overrides,
  };
}

/** issueDiscoveryShare 1 → `issue_discovery` lane; 0 → `direct_pr`; 0.4 with emission → `split`. */
function laneRepo(fullName: string, issueDiscoveryShare: number): Json {
  return repo(fullName, { registryConfig: registryConfig({ repo: fullName, issueDiscoveryShare }) });
}

function issue(repoFullName: string, number: number, title: string, overrides: Json = {}): Json {
  return {
    repoFullName,
    number,
    title,
    state: "open",
    authorLogin: "reporter",
    authorAssociation: "NONE",
    htmlUrl: `https://github.com/${repoFullName}/issues/${number}`,
    body: "x".repeat(220),
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
    labels: [],
    linkedPrs: [],
    ...overrides,
  };
}

function pr(repoFullName: string, number: number, overrides: Json = {}): Json {
  return {
    repoFullName,
    number,
    title: `PR ${number}`,
    state: "open",
    authorLogin: "contributor",
    authorAssociation: "NONE",
    headSha: "abc",
    headRef: "branch",
    baseRef: "main",
    htmlUrl: `https://github.com/${repoFullName}/pull/${number}`,
    mergedAt: null,
    isDraft: false,
    mergeableState: "clean",
    reviewDecision: null,
    body: "",
    createdAt: now(),
    updatedAt: now(),
    closedAt: null,
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

function merged(repoFullName: string, number: number, overrides: Json = {}): Json {
  return {
    repoFullName,
    number,
    title: `Merged ${number}`,
    authorLogin: "contributor",
    htmlUrl: `https://github.com/${repoFullName}/pull/${number}`,
    labels: [],
    linkedIssues: [],
    ...overrides,
  };
}

function bounty(repoFullName: string, issueNumber: number, status: string, overrides: Json = {}): Json {
  return { id: `b-${issueNumber}-${status}`, repoFullName, issueNumber, status, discoveredAt: now(), updatedAt: now(), payload: {}, ...overrides };
}

function emptyCollisions(fullName: string): Json {
  return { repoFullName: fullName, generatedAt: now(), clusters: [], summary: { clusterCount: 0, highRiskCount: 0, itemsReviewed: 0 } };
}

/** The dist barrel is consumed untyped here (same as the sibling suites), so pin the shape once. */
const build = buildIssueQualityReport as unknown as (...args: unknown[]) => {
  repoFullName: string;
  lane: { lane: string };
  summary: string;
  issues: { number: number; title: string; status: string; score: number; reasons: string[]; warnings: string[] }[];
};

const first = (report: ReturnType<typeof build>) => report.issues[0]!;

test("barrel: the public entrypoint re-exports the package-local issue-quality API", () => {
  assert.equal(typeof buildIssueQualityReport, "function");
});

test("buildIssueQualityReport: a detailed open issue with no linked work is ready", () => {
  const r = laneRepo("acme/ready", 1);
  const report = build(r, [issue("acme/ready", 1, "Actionable")], [], "acme/ready");
  assert.equal(report.issues.length, 1);
  assert.equal(first(report).status, "ready");
  assert.equal(report.repoFullName, "acme/ready");
  assert.ok(first(report).reasons.includes("Issue has enough body detail to evaluate."));
  assert.ok(first(report).reasons.includes("No active PR is linked in cached metadata."));
  assert.match(report.summary, /1 open issue\(s\) evaluated; 1 look ready/);
});

test("buildIssueQualityReport: a linked open PR blocks the issue and a thin body needs proof", () => {
  const r = laneRepo("acme/linked", 1);
  const withPr = build(r, [issue("acme/linked", 2, "Claimed")], [pr("acme/linked", 9, { linkedIssues: [2] })], "acme/linked");
  assert.equal(first(withPr).status, "do_not_use");
  assert.ok(first(withPr).warnings.some((w) => /active PR/i.test(w)));

  const thin = build(r, [issue("acme/linked", 3, "Thin", { body: "Short." })], [], "acme/linked");
  assert.equal(first(thin).status, "needs_proof");
  assert.ok(first(thin).warnings.some((w) => /body is thin/i.test(w)));
});

test("buildIssueQualityReport: labels are echoed as a reason and a direct-PR lane warns", () => {
  const r = laneRepo("acme/direct", 0);
  const report = build(r, [issue("acme/direct", 4, "Direct", { labels: ["bug", "good first issue"] })], [], "acme/direct", [], emptyCollisions("acme/direct"), []);
  assert.equal(report.lane.lane, "direct_pr");
  assert.equal(first(report).status, "needs_proof");
  assert.ok(first(report).reasons.includes("Labels: bug, good first issue."));
  assert.ok(first(report).warnings.some((w) => /direct-PR first/i.test(w)));
});

test("buildIssueQualityReport: every bounty lifecycle arm maps to its own status", () => {
  const r = laneRepo("acme/bounty", 1);
  const open = issue("acme/bounty", 5, "Bountied");

  const active = build(r, [open], [], "acme/bounty", [bounty("acme/bounty", 5, "active")]);
  assert.ok(first(active).reasons.some((reason) => /Active bounty context/i.test(reason)));

  for (const status of ["completed", "cancelled", "historical"]) {
    const report = build(r, [open], [], "acme/bounty", [bounty("acme/bounty", 5, status)]);
    assert.equal(first(report).status, "do_not_use", `${status} bounty should block`);
  }

  const stale = build(r, [open], [], "acme/bounty", [bounty("acme/bounty", 5, "active", { updatedAt: daysAgoIso(60), discoveredAt: daysAgoIso(60) })]);
  assert.equal(first(stale).status, "needs_proof");
  assert.ok(first(stale).warnings.some((w) => /looks stale/i.test(w)));

  const ambiguous = build(r, [open], [], "acme/bounty", [bounty("acme/bounty", 5, "weird-unknown-status")]);
  assert.equal(first(ambiguous).status, "needs_proof");
  assert.ok(first(ambiguous).warnings.some((w) => /ambiguous/i.test(w)));
});

test("buildIssueQualityReport: duplicate and invalid labelling drive lifecycle do_not_use", () => {
  const r = laneRepo("acme/labels", 1);
  for (const label of ["duplicate", "wontfix", "invalid", "not planned", "won't fix"]) {
    const report = build(r, [issue("acme/labels", 10, "Labelled", { labels: [label] })], [], "acme/labels");
    assert.equal(first(report).status, "do_not_use", `${label} should block`);
    assert.ok(first(report).warnings.some((w) => /lifecycle is/i.test(w)));
  }
});

test("buildIssueQualityReport: only open issues are reported, closed ones are filtered", () => {
  const r = laneRepo("acme/mixed", 1);
  const report = build(r, [issue("acme/mixed", 12, "Closed", { state: "closed" }), issue("acme/mixed", 13, "Open")], [], "acme/mixed");
  assert.deepEqual(
    report.issues.map((i) => i.number),
    [13],
  );
});

test("buildIssueQualityReport: merged solvers mark valid_solved, and a self-solved loop stays solved", () => {
  const discovery = laneRepo("acme/solved", 1);
  const solved = build(discovery, [issue("acme/solved", 20, "Solved")], [], "acme/solved", [], undefined, [
    merged("acme/solved", 100, { linkedIssues: [20], authorLogin: "other" }),
  ]);
  assert.equal(first(solved).status, "do_not_use");
  assert.ok(first(solved).warnings.some((w) => /merged PR/i.test(w)));

  // Reporter authored the solving PR → selfSolvedLoop suppresses valid_solved.
  const selfSolved = build(
    discovery,
    [issue("acme/solved", 21, "Self", { authorLogin: "reporter" })],
    [pr("acme/solved", 101, { linkedIssues: [21], authorLogin: "reporter", mergedAt: now(), state: "merged" })],
    "acme/solved",
  );
  assert.equal(first(selfSolved).status, "do_not_use");

  // split lane (issueDiscoveryShare 0.4 + emission) also earns valid_solved.
  const split = laneRepo("acme/split", 0.4);
  const splitSolved = build(split, [issue("acme/split", 90, "Split")], [], "acme/split", [], undefined, [
    merged("acme/split", 900, { linkedIssues: [90], authorLogin: "other" }),
  ]);
  assert.equal(first(splitSolved).status, "do_not_use");
});

test("buildIssueQualityReport: stale issues warn and age over 180 days costs score", () => {
  const r = laneRepo("acme/stale", 1);
  const stale = build(r, [issue("acme/stale", 30, "Old", { updatedAt: daysAgoIso(100), createdAt: daysAgoIso(100) })], [], "acme/stale");
  assert.equal(first(stale).status, "needs_proof");
  assert.ok(first(stale).warnings.some((w) => /stale/i.test(w)));

  const ancient = build(r, [issue("acme/stale", 31, "Ancient", { updatedAt: daysAgoIso(200), createdAt: daysAgoIso(200) })], [], "acme/stale");
  const fresh = build(r, [issue("acme/stale", 32, "Fresh")], [], "acme/stale");
  assert.ok(first(ancient).score < first(fresh).score);
});

test("buildIssueQualityReport: maintainer-authored and maintainer-WIP issues carry distinct warnings", () => {
  const r = laneRepo("acme/maint", 1);
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    const authored = build(r, [issue("acme/maint", 40, "From staff", { authorAssociation: association })], [], "acme/maint");
    assert.ok(first(authored).warnings.some((w) => /Maintainer-authored; confirm/i.test(w)), association);
  }

  const wip = build(r, [issue("acme/maint", 41, "WIP", { authorAssociation: "MEMBER", labels: ["Work In Progress "] })], [], "acme/maint");
  assert.equal(first(wip).status, "needs_proof");
  assert.ok(first(wip).warnings.some((w) => /in-progress\/internal/i.test(w)));
  // The WIP arm replaces the plain maintainer-authored warning rather than stacking with it.
  assert.equal(
    first(wip).warnings.some((w) => /Maintainer-authored; confirm/i.test(w)),
    false,
  );

  // A non-maintainer carrying a WIP label is not treated as maintainer WIP.
  const outsider = build(r, [issue("acme/maint", 42, "Outsider WIP", { authorAssociation: "NONE", labels: ["wip"] })], [], "acme/maint");
  assert.equal(
    first(outsider).warnings.some((w) => /in-progress\/internal/i.test(w)),
    false,
  );
});

test("buildIssueQualityReport: issue.linkedPrs back-references resolve, unknown ones warn from cache", () => {
  const r = laneRepo("acme/backref", 1);
  // The PR does not declare the issue; the issue declares the PR → resolveLinkedPullRequests adds it.
  const backref = build(r, [issue("acme/backref", 50, "Backref", { linkedPrs: [77] })], [pr("acme/backref", 77, { linkedIssues: [] })], "acme/backref");
  assert.equal(first(backref).status, "do_not_use");
  assert.ok(first(backref).warnings.some((w) => /active PR/i.test(w)));

  // linkedPrs points at a PR absent from the fetched list → cached-metadata warning only.
  const cachedOnly = build(r, [issue("acme/backref", 51, "Cached", { linkedPrs: [999] })], [], "acme/backref");
  assert.ok(first(cachedOnly).warnings.some((w) => /already references PR\(s\): #999/.test(w)));

  // Merged-PR back-reference travels the same path through the recent-merged index.
  const mergedBackref = build(r, [issue("acme/backref", 52, "Merged backref", { linkedPrs: [78] })], [], "acme/backref", [], undefined, [
    merged("acme/backref", 78, { linkedIssues: [] }),
  ]);
  assert.equal(first(mergedBackref).status, "do_not_use");
});

test("buildIssueQualityReport: high-risk collision clusters block, lower risk only warns", () => {
  const r = laneRepo("acme/collide", 1);
  const cluster = (risk: string): Json => ({
    repoFullName: "acme/collide",
    generatedAt: now(),
    summary: { clusterCount: 1, highRiskCount: risk === "high" ? 1 : 0, itemsReviewed: 2 },
    clusters: [
      {
        id: "c1",
        risk,
        reason: "overlap",
        items: [
          { type: "issue", number: 60, title: "A" },
          { type: "pull_request", number: 1, title: "B" },
        ],
      },
    ],
  });

  const high = build(r, [issue("acme/collide", 60, "A")], [], "acme/collide", [], cluster("high"));
  assert.equal(first(high).status, "do_not_use");

  const medium = build(r, [issue("acme/collide", 60, "A")], [], "acme/collide", [], cluster("medium"));
  assert.ok(first(medium).warnings.some((w) => /duplicate or overlapping/i.test(w)));
  assert.notEqual(first(medium).status, "do_not_use");
});

test("buildIssueQualityReport: results sort by score desc then issue number asc", () => {
  const r = laneRepo("acme/sort", 1);
  const report = build(
    r,
    [issue("acme/sort", 2, "Thin", { body: "Short." }), issue("acme/sort", 1, "Ready"), issue("acme/sort", 3, "Ready too")],
    [],
    "acme/sort",
    [],
    emptyCollisions("acme/sort"),
  );
  assert.deepEqual(
    report.issues.map((i) => i.number),
    [1, 3, 2],
  );
});

test("buildIssueQualityReport: a null repo, absent dates and a blank bounty status degrade safely", () => {
  const report = build(null, [issue("acme/null", 70, "No dates", { updatedAt: null, createdAt: null, body: null })], [], "acme/null", [
    bounty("acme/null", 70, "   "),
  ]);
  assert.equal(report.lane.lane, "unknown");
  assert.equal(first(report).status, "needs_proof");

  // Unparseable timestamps normalize to age 0 rather than throwing or reading as ancient.
  const r = laneRepo("acme/null", 1);
  const badDate = build(r, [issue("acme/null", 71, "Bad date", { updatedAt: "not-a-date", createdAt: "also-bad" })], [], "acme/null");
  assert.equal(first(badDate).status, "ready");
});

test("buildIssueQualityReport: repeated linked-issue references collapse into one PR bucket", () => {
  const r = laneRepo("acme/multi", 1);
  const multi = build(
    r,
    [issue("acme/multi", 91, "Crowded")],
    [pr("acme/multi", 1, { linkedIssues: [91] }), pr("acme/multi", 2, { linkedIssues: [91, 91] })],
    "acme/multi",
  );
  assert.equal(first(multi).status, "do_not_use");
  assert.ok(first(multi).warnings.some((w) => /^2 active PR/.test(w)));
});

test("buildIssueQualityReport: an open issue past the lifecycle cap is still classified (#6141)", () => {
  const r = laneRepo("acme/cap", 1);
  const filler = Array.from({ length: 300 }, (_, i) => issue("acme/cap", i + 1, `Closed ${i + 1}`, { state: "closed" }));
  const beyondCap = issue("acme/cap", 301, "Beyond cap duplicate", { labels: ["duplicate"] });
  const report = build(r, [...filler, beyondCap], [], "acme/cap");
  assert.equal(report.issues.length, 1);
  assert.equal(first(report).number, 301);
  assert.equal(first(report).status, "do_not_use");
});

test("buildIssueQualityReport: the report caps at 100 issues", () => {
  const r = laneRepo("acme/cap100", 1);
  const many = Array.from({ length: 140 }, (_, i) => issue("acme/cap100", i + 1, `Open ${i + 1}`));
  const report = build(r, many, [], "acme/cap100");
  assert.equal(report.issues.length, 100);
});
