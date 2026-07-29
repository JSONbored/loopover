import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPO_SEGMENT_PATTERN,
  buildSoftClaimRequest,
  isValidRepoSegment,
  normalizeDiscoveryIndexCandidate,
  normalizeDiscoveryIndexResponse,
  validateIdeaSubmission,
} from "../dist/index.js";

// #9610: the "."/".." path-safety segment guard from the #5831 -> #7525 -> #8350 family now lives in one
// shared module (repo-segment.ts) and is applied by every engine-package owner/repo normalizer, not just
// governor-ledger's write path (whose own traversal tests live in governor-ledger.test.ts).

test("repo-segment: isValidRepoSegment accepts GitHub-legal slugs and rejects traversal/non-slug segments (#9610)", () => {
  for (const segment of ["acme", "a.b_c-d9", "...three-dots-are-a-slug..."]) {
    assert.equal(isValidRepoSegment(segment), true, segment);
    assert.equal(REPO_SEGMENT_PATTERN.test(segment), true, segment);
  }
  for (const segment of ["evil repo", "", "a/b", ".", ".."]) {
    assert.equal(isValidRepoSegment(segment), false, segment);
  }
});

test("idea-intake: a '.'/'..' traversal segment in a bare-string targetRepo is rejected at intake (#9610)", () => {
  const idea = { id: "idea-1", title: "t", body: "b" };
  for (const targetRepo of ["../evilrepo", "./x", "a/..", "../..", "/x", "x/", "a/b/c", "no-slash", "evil repo/x"]) {
    assert.deepEqual(
      validateIdeaSubmission({ ...idea, targetRepo }),
      { ok: false, errors: ["target_repo_malformed"] },
      targetRepo,
    );
  }
  const accepted = validateIdeaSubmission({ ...idea, targetRepo: "acme/widgets" });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.idea.targetRepo, { kind: "existing", repo: "acme/widgets" });
});

test("discovery-index contract: a traversal-segment repoFullName fails candidate normalization (#9610)", () => {
  for (const repoFullName of ["../evil", "evil/..", "./evil"]) {
    assert.equal(normalizeDiscoveryIndexCandidate({ repoFullName, issueNumber: 1, title: "x" }), null, repoFullName);
  }
  const valid = normalizeDiscoveryIndexCandidate({ repoFullName: "owner/repo", issueNumber: 1, title: "x" });
  assert.equal(valid?.repoFullName, "owner/repo");

  const parsed = normalizeDiscoveryIndexResponse({
    candidates: [
      { repoFullName: "../evil", issueNumber: 1, title: "x" },
      { repoFullName: "owner/repo", issueNumber: 2, title: "y" },
    ],
  });
  assert.deepEqual(parsed.response.candidates.map((candidate) => candidate.repoFullName), ["owner/repo"]);
  assert.ok(parsed.warnings.includes("DiscoveryIndexResponse dropped an invalid or boundary-violating candidate."));
});

test("discovery soft-claim: a traversal-segment repoFullName never becomes a soft-claim request (#9610)", () => {
  const claim = { id: 7, repoFullName: "owner/repo", issueNumber: 42, claimedAt: "2026-01-01T00:00:00Z", status: "active" as const };
  for (const repoFullName of ["../evil", "evil/..", "./evil"]) {
    assert.equal(buildSoftClaimRequest({ ...claim, repoFullName }), null, repoFullName);
  }
  assert.equal(buildSoftClaimRequest(claim)?.repoFullName, "owner/repo");
});
