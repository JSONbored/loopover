import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINTAINER_AUTHOR_ASSOCIATIONS, classifyAuthorAssociation, isMaintainerAuthorAssociation } from "../dist/index.js";

// The engine's own behaviour suite for the author-association vocabulary (#9743). gate-advisory -- an
// engine twin -- is one of its callers, and the per-author-class parity rollups publish this split, so
// these are engine semantics rather than app glue.

test("every maintainer association classifies as maintainer, case-insensitively", () => {
  for (const association of MAINTAINER_AUTHOR_ASSOCIATIONS) {
    assert.equal(classifyAuthorAssociation(association), "maintainer", association);
    assert.equal(classifyAuthorAssociation(association.toLowerCase()), "maintainer", association);
    assert.equal(isMaintainerAuthorAssociation(association), true, association);
  }
});

test("CONTRIBUTOR is a contributor -- a merged PR in the past is not authority over the repo", () => {
  assert.equal(isMaintainerAuthorAssociation("CONTRIBUTOR"), false);
  assert.equal(classifyAuthorAssociation("CONTRIBUTOR"), "contributor");
  assert.equal(classifyAuthorAssociation("FIRST_TIME_CONTRIBUTOR"), "contributor");
  assert.equal(classifyAuthorAssociation("NONE"), "contributor");
});

test("an unrecorded association is UNKNOWN, never folded into either side", () => {
  // Folding unknowns into `contributor` would bias the exact comparison the rollups publish.
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(classifyAuthorAssociation(value as never), "unknown", JSON.stringify(value));
    assert.equal(isMaintainerAuthorAssociation(value as never), false, JSON.stringify(value));
  }
});

test("a non-string is not treated as an association", () => {
  assert.equal(isMaintainerAuthorAssociation(42 as never), false);
  assert.equal(classifyAuthorAssociation(42 as never), "unknown");
});

// The gate-advisory TWIN is one of this predicate's callers (#9743 consolidated a fifth copy out of it),
// so the branch it feeds is exercised here too rather than only through the app's own suite.
test("buildPullRequestAdvisory raises maintainer_authored_pr for a maintainer association", async () => {
  const { buildPullRequestAdvisory } = await import("../dist/advisory/gate-advisory.js");
  const repo = { fullName: "o/r", defaultBranch: "main" } as never;
  const basePr = {
    repoFullName: "o/r",
    number: 1,
    title: "fix: a thing",
    state: "open",
    authorLogin: "someone",
    labels: [],
    linkedIssues: [],
    bodyObservedAt: null,
  };

  const maintainer = buildPullRequestAdvisory(repo, { ...basePr, authorAssociation: "MEMBER" } as never, {});
  assert.ok(
    maintainer.findings.some((f) => f.code === "maintainer_authored_pr"),
    "a MEMBER-authored PR is flagged as maintainer-authored",
  );

  const contributor = buildPullRequestAdvisory(repo, { ...basePr, authorAssociation: "CONTRIBUTOR" } as never, {});
  assert.equal(
    contributor.findings.some((f) => f.code === "maintainer_authored_pr"),
    false,
    "a CONTRIBUTOR-authored PR is not",
  );
});
