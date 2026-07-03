// Units for the review/approval integrity analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  latestReviewPerReviewer,
  scanApprovalIntegrity,
} from "../dist/analyzers/approval-integrity.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "ghp_test",
  headSha: "head0000000000000000000000000000000000",
  ...extra,
});

const reviewsFetch = (reviews) => async () => jsonResponse(reviews);

const review = (login, state, commitId, submittedAt) => ({
  user: { login },
  state,
  commit_id: commitId,
  submitted_at: submittedAt,
});

test("latestReviewPerReviewer: keeps only the latest-submitted review per login", () => {
  const latest = latestReviewPerReviewer([
    review("alice", "CHANGES_REQUESTED", "sha1", "2026-01-01T00:00:00Z"),
    review("alice", "APPROVED", "sha2", "2026-01-02T00:00:00Z"),
    review("bob", "APPROVED", "sha1", "2026-01-01T00:00:00Z"),
  ]);
  assert.equal(latest.size, 2);
  assert.equal(latest.get("alice").state, "APPROVED");
  assert.equal(latest.get("alice").commitId, "sha2");
  assert.equal(latest.get("bob").state, "APPROVED");
});

test("latestReviewPerReviewer: excludes a PENDING draft review (no submitted_at)", () => {
  const latest = latestReviewPerReviewer([
    { user: { login: "alice" }, state: "PENDING", commit_id: "sha1", submitted_at: null },
  ]);
  assert.equal(latest.size, 0);
});

test("latestReviewPerReviewer: groups logins case-insensitively, keeping the latest", () => {
  const latest = latestReviewPerReviewer([
    review("Alice", "CHANGES_REQUESTED", "sha1", "2026-01-01T00:00:00Z"),
    review("alice", "APPROVED", "sha2", "2026-01-02T00:00:00Z"),
  ]);
  assert.equal(latest.size, 1);
  assert.equal(latest.get("alice").state, "APPROVED");
  assert.equal(latest.get("alice").login, "alice"); // the winning (latest) review's own-case login is kept
});

test("latestReviewPerReviewer: skips a malformed entry missing user/state/submitted_at", () => {
  const latest = latestReviewPerReviewer([
    { state: "APPROVED", commit_id: "sha1", submitted_at: "2026-01-01T00:00:00Z" }, // no user
    { user: { login: "bob" }, commit_id: "sha1", submitted_at: "2026-01-01T00:00:00Z" }, // no state
    { user: { login: "carol" }, state: "APPROVED", submitted_at: undefined }, // no submitted_at
  ]);
  assert.equal(latest.size, 0);
});

test("latestReviewPerReviewer: on a submitted_at tie, the LATER item in API order wins", () => {
  const latest = latestReviewPerReviewer([
    review("alice", "CHANGES_REQUESTED", "sha1", "2026-01-01T00:00:00Z"),
    review("alice", "APPROVED", "sha2", "2026-01-01T00:00:00Z"), // same timestamp, later in API (oldest-first) order
  ]);
  assert.equal(latest.get("alice").state, "APPROVED");
  assert.equal(latest.get("alice").commitId, "sha2");
});

test("scanApprovalIntegrity: flags an approval that predates the current head commit", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([review("alice", "APPROVED", "old-sha-1234567890", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, [
    { reviewer: "alice", kind: "stale-approval", reviewedShaPrefix: "old-sha-1234" },
  ]);
  const brief = renderBrief({ approvalIntegrity: findings }).promptSection;
  assert.match(brief, /predates the current head commit/);
});

test("scanApprovalIntegrity: an approval on the current head commit is fresh (no finding)", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([review("alice", "APPROVED", req().headSha, "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: flags the author approving their own PR", async () => {
  const findings = await scanApprovalIntegrity(
    req({ author: "octocat" }),
    reviewsFetch([review("octocat", "APPROVED", req().headSha, "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, [{ reviewer: "octocat", kind: "self-approval" }]);
  const brief = renderBrief({ approvalIntegrity: findings }).promptSection;
  assert.match(brief, /approved their own PR/);
});

test("scanApprovalIntegrity: self-approval comparison is case-insensitive", async () => {
  const findings = await scanApprovalIntegrity(
    req({ author: "Octocat" }),
    reviewsFetch([review("octocat", "APPROVED", req().headSha, "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, [{ reviewer: "octocat", kind: "self-approval" }]);
});

test("scanApprovalIntegrity: a stale AND self approval on the same review yields both findings", async () => {
  const findings = await scanApprovalIntegrity(
    req({ author: "octocat" }),
    reviewsFetch([review("octocat", "APPROVED", "old-sha-1234567890", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, [
    { reviewer: "octocat", kind: "stale-approval", reviewedShaPrefix: "old-sha-1234" },
    { reviewer: "octocat", kind: "self-approval" },
  ]);
});

test("scanApprovalIntegrity: no self-approval finding when the PR has no known author", async () => {
  const findings = await scanApprovalIntegrity(
    req(), // no `author`
    reviewsFetch([review("octocat", "APPROVED", req().headSha, "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: flags a reviewer whose current review is still CHANGES_REQUESTED", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([review("bob", "CHANGES_REQUESTED", "sha1", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, [{ reviewer: "bob", kind: "outstanding-changes-requested" }]);
  const brief = renderBrief({ approvalIntegrity: findings }).promptSection;
  assert.match(brief, /still requesting changes/);
});

test("scanApprovalIntegrity: a later APPROVED supersedes an earlier CHANGES_REQUESTED (no longer outstanding)", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([
      review("bob", "CHANGES_REQUESTED", "sha1", "2026-01-01T00:00:00Z"),
      review("bob", "APPROVED", req().headSha, "2026-01-02T00:00:00Z"),
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: a dismissed review (state DISMISSED) is not outstanding", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([review("bob", "DISMISSED", "sha1", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: a COMMENTED review yields no finding", async () => {
  const findings = await scanApprovalIntegrity(
    req(),
    reviewsFetch([review("bob", "COMMENTED", "sha1", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanApprovalIntegrity(
    req({ githubToken: undefined }),
    reviewsFetch([review("alice", "APPROVED", "old-sha", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: no head SHA → skipped (no finding, no throw)", async () => {
  const findings = await scanApprovalIntegrity(
    req({ headSha: undefined }),
    reviewsFetch([review("alice", "APPROVED", "old-sha", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanApprovalIntegrity(
    req({ repoFullName: "not-a-valid-slug" }),
    reviewsFetch([review("alice", "APPROVED", "old-sha", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: a fetch failure yields no finding", async () => {
  const findings = await scanApprovalIntegrity(req(), async () => jsonResponse({ message: "bad" }, 500));
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: no reviews yields no finding", async () => {
  const findings = await scanApprovalIntegrity(req(), reviewsFetch([]));
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: requests the first page of reviews with the expected URL shape", async () => {
  let requestedUrl;
  const findings = await scanApprovalIntegrity(req(), async (url) => {
    requestedUrl = url;
    return jsonResponse([]);
  });
  assert.deepEqual(findings, []);
  assert.match(requestedUrl, /\/pulls\/7\/reviews\?per_page=100&page=1$/);
  assert.match(requestedUrl, /^https:\/\/api\.github\.com\/repos\/octo\/repo\//);
});

test("scanApprovalIntegrity: a short page (< per_page) stops pagination without a second request", async () => {
  let calls = 0;
  const findings = await scanApprovalIntegrity(req(), async () => {
    calls += 1;
    return jsonResponse([review("alice", "APPROVED", req().headSha, "2026-01-01T00:00:00Z")]);
  });
  assert.deepEqual(findings, []);
  assert.equal(calls, 1);
});

test("scanApprovalIntegrity: walks a second page to find a reviewer's true latest vote (>100 reviews)", async () => {
  // Page 1 (oldest-first, as GitHub returns them) is a full page ending on alice's CHANGES_REQUESTED; her real
  // latest vote — an APPROVED on the current head commit — is on page 2. Reading only page 1 would wrongly report
  // her as still requesting changes.
  const page1 = Array.from({ length: 100 }, (_, i) =>
    i === 99
      ? review("alice", "CHANGES_REQUESTED", "sha-old", "2026-01-01T00:00:00Z")
      : review(`bystander${i}`, "COMMENTED", "sha-old", "2026-01-01T00:00:00Z"),
  );
  const page2 = [review("alice", "APPROVED", req().headSha, "2026-01-02T00:00:00Z")];
  let calls = 0;
  const findings = await scanApprovalIntegrity(req(), async (url) => {
    calls += 1;
    return jsonResponse(url.includes("page=2") ? page2 : page1);
  });
  assert.equal(calls, 2);
  assert.deepEqual(findings, []); // alice's true latest vote is a fresh approval, not outstanding
});

test("scanApprovalIntegrity: pagination is bounded, and an unconfirmed-complete history (still-full last page) fails closed", async () => {
  let calls = 0;
  // Every page is full, including page 10 (MAX_PAGES) — so we can never confirm this is the reviewer's true
  // latest vote (an 11th page might exist). A naive "return what we have" would wrongly report bob as still
  // requesting changes; failing closed (no finding) is correct here.
  const fullPage = (marker) =>
    Array.from({ length: 100 }, (_, i) => (i === 99 ? review("bob", "CHANGES_REQUESTED", marker, "2026-01-01T00:00:00Z") : review(`user${i}`, "COMMENTED", marker, "2026-01-01T00:00:00Z")));
  const findings = await scanApprovalIntegrity(req(), async () => {
    calls += 1;
    return jsonResponse(fullPage(`sha-${calls}`));
  });
  assert.equal(calls, 10); // MAX_PAGES, not unbounded
  assert.deepEqual(findings, []); // completeness unconfirmed → fails closed, not a false "outstanding" finding
});

test("scanApprovalIntegrity: a later-page fetch failure fails the whole call closed (no false findings from partial history)", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) =>
    i === 99
      ? review("bob", "CHANGES_REQUESTED", "sha-old", "2026-01-01T00:00:00Z")
      : review(`bystander${i}`, "COMMENTED", "sha-old", "2026-01-01T00:00:00Z"),
  );
  const findings = await scanApprovalIntegrity(req(), async (url) => {
    if (url.includes("page=2")) return jsonResponse({ message: "boom" }, 500);
    return jsonResponse(page1);
  });
  // page 2 (which might hold bob's true latest vote — e.g. a superseding APPROVED) failed to fetch, so treating
  // page 1's CHANGES_REQUESTED as his current state could be wrong. Fail closed: no finding, not a stale one.
  assert.deepEqual(findings, []);
});

test("scanApprovalIntegrity: stale-approval commit SHA comparison is case-insensitive", async () => {
  const findings = await scanApprovalIntegrity(
    req({ headSha: "AbCdEf0000000000000000000000000000000000".toLowerCase() }),
    reviewsFetch([review("alice", "APPROVED", "ABCDEF0000000000000000000000000000000000", "2026-01-01T00:00:00Z")]),
  );
  assert.deepEqual(findings, []); // same SHA, different case → NOT stale
});
