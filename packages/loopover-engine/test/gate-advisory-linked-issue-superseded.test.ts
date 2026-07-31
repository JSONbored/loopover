import { test } from "node:test";
import assert from "node:assert/strict";

// #10168, engine-twin half. The host copy (src/rules/advisory.ts) has the same split and its own suite; both
// are covered because gate-advisory is a deliberately-divergent twin, so a fix applied to only one side is
// exactly the drift this pair of suites exists to catch.
//
// The case: a contributor links a genuinely open issue, a rival PR citing the same issue merges first, and
// the issue closes behind it. The PR then reads as "no open linked issue" -- and telling that contributor to
// "link it explicitly in the PR body" is advice that cannot work.

const repo = { fullName: "o/r", defaultBranch: "main" } as never;
const supersededPr = {
  repoFullName: "o/r",
  number: 8886,
  title: "fix: a thing",
  state: "open",
  authorLogin: "someone",
  authorAssociation: "CONTRIBUTOR",
  labels: [],
  linkedIssues: [8829],
  bodyObservedAt: "2026-07-31T09:22:36Z",
};
const supersededBy = { issueNumber: 8829, rivalPullNumber: 8881 };

test("a superseded PR is reported as superseded, naming the rival that merged", async () => {
  const { buildPullRequestAdvisory } = await import("../dist/advisory/gate-advisory.js");
  const advisory = buildPullRequestAdvisory(repo, supersededPr as never, {
    requireLinkedIssue: true,
    confirmedNoOpenLinkedIssue: true,
    supersededBy,
  });

  const finding = advisory.findings.find((f) => f.code === "linked_issue_superseded");
  assert.ok(finding, "the supersession finding is raised");
  assert.equal(finding.title, "Superseded by a merged pull request");
  assert.match(finding.detail, /#8829 was closed by #8881/);
  assert.ok(
    !advisory.findings.some((f) => f.code === "missing_linked_issue"),
    "the unactionable missing_linked_issue reading is replaced, not doubled up",
  );
  assert.ok(!/link it explicitly in the PR body/.test(finding.action ?? ""), "the advice that cannot work is gone");
  assert.match(finding.action ?? "", /#8881/, "the remedy points at the rival that actually landed");
});

test("without proven supersession the anti-gaming reading is unchanged", async () => {
  const { buildPullRequestAdvisory } = await import("../dist/advisory/gate-advisory.js");
  for (const value of [undefined, null]) {
    const advisory = buildPullRequestAdvisory(repo, supersededPr as never, {
      requireLinkedIssue: true,
      confirmedNoOpenLinkedIssue: true,
      supersededBy: value,
    });
    assert.ok(
      advisory.findings.some((f) => f.code === "missing_linked_issue"),
      `missing_linked_issue still fires for supersededBy=${String(value)}`,
    );
    assert.ok(
      !advisory.findings.some((f) => f.code === "linked_issue_superseded"),
      `no supersession is claimed for supersededBy=${String(value)}`,
    );
  }
});

test("supersession never fires while the linked-issue requirement is off", async () => {
  const { buildPullRequestAdvisory } = await import("../dist/advisory/gate-advisory.js");
  const advisory = buildPullRequestAdvisory(repo, supersededPr as never, {
    requireLinkedIssue: false,
    confirmedNoOpenLinkedIssue: true,
    supersededBy,
  });
  assert.ok(!advisory.findings.some((f) => f.code === "linked_issue_superseded"));
});
