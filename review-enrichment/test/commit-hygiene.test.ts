// Units for the commit-history hygiene analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCommitHygiene,
  scanCommitHygiene,
} from "../dist/analyzers/commit-hygiene.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "test-token",
  ...extra,
});

const commitsFetch = (commits) => async () => jsonResponse(commits);

const commit = (sha, message, parentShas = ["parent0000000000000000000000000000000000"]) => ({
  sha,
  commit: { message },
  parents: parentShas.map((s) => ({ sha: s })),
});

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("analyzeCommitHygiene: flags a merge commit (more than one parent) pulled into the PR history", () => {
  const findings = analyzeCommitHygiene([
    commit(SHA_A, "Merge branch 'main' into feature", ["p1000000000000000000000000000000000000", "p2000000000000000000000000000000000000"]),
  ]);
  assert.deepEqual(findings, [{ shaPrefix: "aaaaaaaaaaaa", kind: "merge-commit-in-history" }]);
});

test("analyzeCommitHygiene: a normal single-parent commit is not flagged as a merge commit", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "fix: correct off-by-one")]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: a root commit with no parents is not flagged as a merge commit", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "chore: initial commit", [])]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: flags a fixup! commit", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "fixup! feat: add the new widget")]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "fixup! feat: add the new widget" },
  ]);
  const brief = renderBrief({ commitHygiene: findings }).promptSection;
  assert.match(brief, /unsquashed fixup\/squash commit/);
});

test("analyzeCommitHygiene: flags a squash! commit", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "squash! fix: typo")]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "squash! fix: typo" },
  ]);
});

test("analyzeCommitHygiene: fixup!/squash! matching is case-insensitive and trims the subject", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "FIXUP!   fix: typo  \nextra body line")]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "FIXUP!   fix: typo" },
  ]);
});

test("analyzeCommitHygiene: does not mis-flag a commit that merely mentions 'fixup' mid-subject", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "fix: apply the fixup! marker convention in docs")]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: flags a Co-authored-by trailer", () => {
  const findings = analyzeCommitHygiene([
    commit(SHA_A, "feat: pair-programmed widget\n\nCo-authored-by: Jane Doe <jane@example.com>"),
  ]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "unattributed-co-author", coAuthor: "Jane Doe <jane@example.com>" },
  ]);
  const brief = renderBrief({ commitHygiene: findings }).promptSection;
  assert.match(brief, /credits a co-author/);
});

test("analyzeCommitHygiene: Co-authored-by matching is case-insensitive and tolerant of surrounding whitespace", () => {
  const findings = analyzeCommitHygiene([
    commit(SHA_A, "feat: widget\n\n  co-authored-by:   Jane Doe <jane@example.com>  "),
  ]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "unattributed-co-author", coAuthor: "Jane Doe <jane@example.com>" },
  ]);
});

test("analyzeCommitHygiene: only the first Co-authored-by trailer is reported per commit (no duplicate noise)", () => {
  const findings = analyzeCommitHygiene([
    commit(
      SHA_A,
      "feat: widget\n\nCo-authored-by: Jane Doe <jane@example.com>\nCo-authored-by: Bob Roe <bob@example.com>",
    ),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].coAuthor, "Jane Doe <jane@example.com>");
});

test("analyzeCommitHygiene: a commit message without a well-formed trailer is not flagged", () => {
  const findings = analyzeCommitHygiene([commit(SHA_A, "feat: widget\n\nThanks to Jane for the idea")]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: a single commit can trigger all three kinds independently", () => {
  const findings = analyzeCommitHygiene([
    commit(
      SHA_A,
      "fixup! feat: widget\n\nCo-authored-by: Jane Doe <jane@example.com>",
      ["p1000000000000000000000000000000000000", "p2000000000000000000000000000000000000"],
    ),
  ]);
  assert.deepEqual(findings, [
    { shaPrefix: "aaaaaaaaaaaa", kind: "merge-commit-in-history" },
    { shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "fixup! feat: widget" },
    { shaPrefix: "aaaaaaaaaaaa", kind: "unattributed-co-author", coAuthor: "Jane Doe <jane@example.com>" },
  ]);
});

test("analyzeCommitHygiene: tracks independent commits separately, in list order", () => {
  const findings = analyzeCommitHygiene([
    commit(SHA_A, "fixup! wip"),
    commit(SHA_B, "feat: clean commit"),
  ]);
  assert.deepEqual(findings, [{ shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "fixup! wip" }]);
});

test("analyzeCommitHygiene: a commit missing a sha is skipped, not thrown", () => {
  const findings = analyzeCommitHygiene([{ commit: { message: "fixup! x" }, parents: [] }]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: a commit with no message is treated as an empty subject, not thrown", () => {
  const findings = analyzeCommitHygiene([{ sha: SHA_A, parents: [] }]);
  assert.deepEqual(findings, []);
});

test("analyzeCommitHygiene: no findings for an empty commit list", () => {
  assert.deepEqual(analyzeCommitHygiene([]), []);
});

test("analyzeCommitHygiene: honors the maxFindings bound", () => {
  const commits = Array.from({ length: 30 }, (_, i) =>
    commit(`c${i}`.padEnd(40, "0"), `fixup! change ${i}`),
  );
  const findings = analyzeCommitHygiene(commits, 5);
  assert.equal(findings.length, 5);
});

test("analyzeCommitHygiene: the maxFindings bound is enforced identically when the LAST slot is filled by a co-author finding, not just fixup/merge", () => {
  // Each commit contributes exactly one co-author finding; hitting the cap here must stop the scan just as
  // reliably as hitting it via the merge-commit or fixup-commit branches (regression test for a prior bug where
  // the co-author branch's own inner line-loop break did not propagate to the outer per-commit loop).
  const commits = Array.from({ length: 10 }, (_, i) =>
    commit(`c${i}`.padEnd(40, "0"), `feat: change ${i}\n\nCo-authored-by: Person ${i} <p${i}@example.com>`),
  );
  const findings = analyzeCommitHygiene(commits, 3);
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.kind === "unattributed-co-author"));
});

test("scanCommitHygiene: resolves findings from the commits API response", async () => {
  const findings = await scanCommitHygiene(req(), commitsFetch([commit(SHA_A, "fixup! x")]));
  assert.deepEqual(findings, [{ shaPrefix: "aaaaaaaaaaaa", kind: "fixup-commit-present", subject: "fixup! x" }]);
});

test("scanCommitHygiene: requests the PR's commits with the expected URL shape", async () => {
  let requestedUrl;
  await scanCommitHygiene(req(), async (url) => {
    requestedUrl = url;
    return jsonResponse([]);
  });
  assert.equal(requestedUrl, "https://api.github.com/repos/octo/repo/pulls/7/commits?per_page=100");
});

test("scanCommitHygiene: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanCommitHygiene(
    req({ githubToken: undefined }),
    commitsFetch([commit(SHA_A, "fixup! x")]),
  );
  assert.deepEqual(findings, []);
});

test("scanCommitHygiene: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanCommitHygiene(
    req({ repoFullName: "not-a-valid-slug" }),
    commitsFetch([commit(SHA_A, "fixup! x")]),
  );
  assert.deepEqual(findings, []);
});

test("scanCommitHygiene: a fetch failure yields no finding", async () => {
  const findings = await scanCommitHygiene(req(), async () => jsonResponse({ message: "bad" }, 500));
  assert.deepEqual(findings, []);
});

test("scanCommitHygiene: a malformed response body (not an array) yields no finding", async () => {
  const findings = await scanCommitHygiene(req(), async () => jsonResponse({ not: "an array" }));
  assert.deepEqual(findings, []);
});

test("scanCommitHygiene: no commits yields no finding", async () => {
  const findings = await scanCommitHygiene(req(), commitsFetch([]));
  assert.deepEqual(findings, []);
});
