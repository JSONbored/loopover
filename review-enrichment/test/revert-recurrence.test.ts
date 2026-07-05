// Units for the revert-recurrence analyzer (#1514). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRevertCommit,
  revertedPrNumber,
  diffLineRanges,
  rangesOverlap,
  firstOverlap,
  scanRevertRecurrence,
} from "../dist/analyzers/revert-recurrence.js";
import { renderBrief } from "../dist/render.js";
import { resetExternalFetchCircuitBreakerForTest } from "../dist/external-fetch.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

// A PR patch that adds new-file lines 11-12 to src/a.ts.
const PR_PATCH = "@@ -10,3 +10,4 @@\n ctx1\n+new11\n+new12\n ctx2";
const REVERT_SHA = "abcdef1234567";
// A revert commit whose patch removed old-file lines 11-12 of src/a.ts — overlaps the PR's added 11-12.
const OVERLAP_LIST = [
  { sha: REVERT_SHA, commit: { message: 'Revert "feat: thing (#42)"\n\nThis reverts commit deadbeef1234567.' } },
];
const OVERLAP_DETAIL = {
  [REVERT_SHA]: { files: [{ filename: "src/a.ts", patch: "@@ -11,2 +11,0 @@\n-old11\n-old12" }] },
};

const req = (files) => ({ repoFullName: "octo/repo", prNumber: 1, githubToken: "ghp_test", files });

// Route by URL: the single-commit detail endpoint is `/commits/<sha>`; the commits-by-path list is `/commits?…`.
const routed = (list, detailBySha) => async (url) => {
  if (url.includes("/commits/")) {
    const sha = url.split("/commits/")[1];
    return jsonResponse(detailBySha[sha] ?? { files: [] });
  }
  return jsonResponse(list);
};

test("isRevertCommit: true for a revert subject or a 'This reverts commit' body; false otherwise", () => {
  assert.equal(isRevertCommit('Revert "feat: x (#42)"'), true);
  assert.equal(isRevertCommit("feat: x\n\nThis reverts commit deadbeef123456."), true);
  assert.equal(isRevertCommit("revert bad change"), true);
  assert.equal(isRevertCommit("feat: reverting the plan later"), false); // 'reverting' isn't a whole word, no body trailer
  assert.equal(isRevertCommit("fix: normal change"), false);
  assert.equal(isRevertCommit(""), false);
});

test("revertedPrNumber: extracts the reverted PR number, else undefined", () => {
  assert.equal(revertedPrNumber('Revert "feat: thing (#42)"'), 42);
  assert.equal(revertedPrNumber("This reverts commit deadbeef."), undefined);
  assert.equal(revertedPrNumber('Revert "weird (#0)"'), undefined); // #0 rejected (must be > 0)
});

test("diffLineRanges: extracts added (new-file) and removed (old-file) contiguous ranges", () => {
  const patch = "@@ -10,3 +10,4 @@\n ctx\n+a\n+b\n ctx2\n-gone";
  assert.deepEqual(diffLineRanges(patch, "+"), [{ start: 11, end: 12 }]);
  assert.deepEqual(diffLineRanges(patch, "-"), [{ start: 12, end: 12 }]);
});

test("diffLineRanges: empty, no-hunk, and malformed-header patches yield []", () => {
  assert.deepEqual(diffLineRanges("", "+"), []);
  assert.deepEqual(diffLineRanges("no hunk here\n+notcounted", "+"), []); // no @@ header ⇒ inactive
  assert.deepEqual(diffLineRanges("@@ bad header @@\n+x", "+"), []); // header regex fails ⇒ inactive
});

test("diffLineRanges: spans multiple hunks and skips 'No newline' markers", () => {
  const patch = "@@ -1,1 +1,2 @@\n+a\n b\n@@ -10,1 +11,2 @@\n+c\n\\ No newline at end of file\n+d";
  assert.deepEqual(diffLineRanges(patch, "+"), [{ start: 1, end: 1 }, { start: 11, end: 12 }]);
});

test("rangesOverlap + firstOverlap: inclusive overlap detection", () => {
  assert.equal(rangesOverlap({ start: 1, end: 3 }, { start: 3, end: 5 }), true); // touch at 3
  assert.equal(rangesOverlap({ start: 1, end: 2 }, { start: 3, end: 4 }), false);
  assert.deepEqual(
    firstOverlap([{ start: 1, end: 2 }, { start: 10, end: 12 }], [{ start: 11, end: 11 }]),
    { start: 10, end: 12 },
  );
  assert.equal(firstOverlap([{ start: 1, end: 2 }], [{ start: 5, end: 6 }]), null);
});

test("scanRevertRecurrence: flags a re-introduced range overlapping a reverted region", async () => {
  const findings = await scanRevertRecurrence(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed(OVERLAP_LIST, OVERLAP_DETAIL),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    file: "src/a.ts",
    line: 11,
    revertShaPrefix: "abcdef1",
    revertedPr: 42,
  });
});

test("scanRevertRecurrence: a body-style revert with no PR number omits revertedPr", async () => {
  const list = [{ sha: REVERT_SHA, commit: { message: "This reverts commit deadbeef1234567." } }];
  const findings = await scanRevertRecurrence(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed(list, OVERLAP_DETAIL),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].revertShaPrefix, "abcdef1");
  assert.equal("revertedPr" in findings[0], false);
});

test("scanRevertRecurrence: no revert commit in history ⇒ no finding and no detail fetch", async () => {
  let detailCalled = false;
  const out = await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), async (url) => {
    if (url.includes("/commits/")) {
      detailCalled = true;
      return jsonResponse({ files: [] });
    }
    return jsonResponse([{ sha: "1111111", commit: { message: "feat: add thing" } }]);
  });
  assert.deepEqual(out, []);
  assert.equal(detailCalled, false);
});

test("scanRevertRecurrence: a revert that doesn't overlap the PR's added lines is not flagged", async () => {
  const detail = { [REVERT_SHA]: { files: [{ filename: "src/a.ts", patch: "@@ -100,2 +100,0 @@\n-x\n-y" }] } };
  assert.deepEqual(
    await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), routed(OVERLAP_LIST, detail)),
    [],
  );
});

test("scanRevertRecurrence: a revert whose patch doesn't touch the probed file is not flagged", async () => {
  const detail = { [REVERT_SHA]: { files: [{ filename: "src/other.ts", patch: "@@ -11,2 +11,0 @@\n-a\n-b" }] } };
  assert.deepEqual(
    await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), routed(OVERLAP_LIST, detail)),
    [],
  );
});

test("scanRevertRecurrence: a commit missing a sha is skipped, a later valid revert still flags", async () => {
  const list = [
    { commit: { message: 'Revert "no sha (#7)"' } },
    { sha: REVERT_SHA, commit: { message: 'Revert "feat (#42)"' } },
  ];
  const findings = await scanRevertRecurrence(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed(list, OVERLAP_DETAIL),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].revertedPr, 42);
});

test("scanRevertRecurrence: a file whose patch adds nothing is not probed", async () => {
  let called = false;
  const out = await scanRevertRecurrence(
    req([{ path: "src/a.ts", patch: "@@ -5,2 +5,0 @@\n-gone1\n-gone2" }]),
    async () => {
      called = true;
      return jsonResponse([]);
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanRevertRecurrence: skips lockfiles and binaries without fetching", async () => {
  let called = false;
  const out = await scanRevertRecurrence(
    req([
      { path: "package-lock.json", patch: PR_PATCH },
      { path: "assets/logo.png", patch: PR_PATCH },
    ]),
    async () => {
      called = true;
      return jsonResponse([]);
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanRevertRecurrence: requires a github token and a single valid repo slug", async () => {
  assert.deepEqual(
    await scanRevertRecurrence(
      { repoFullName: "octo/repo", prNumber: 1, files: [{ path: "src/a.ts", patch: PR_PATCH }] },
      routed(OVERLAP_LIST, OVERLAP_DETAIL),
    ),
    [],
  );
  assert.deepEqual(
    await scanRevertRecurrence(
      { repoFullName: "bad slug/x!", prNumber: 1, githubToken: "t", files: [{ path: "src/a.ts", patch: PR_PATCH }] },
      routed(OVERLAP_LIST, OVERLAP_DETAIL),
    ),
    [],
  );
});

test("scanRevertRecurrence: rejects multi-segment repo slugs without fetching", async () => {
  let called = false;
  const out = await scanRevertRecurrence(
    { repoFullName: "octo/repo/extra", prNumber: 1, githubToken: "ghp_test", files: [{ path: "src/a.ts", patch: PR_PATCH }] },
    async () => {
      called = true;
      return jsonResponse(OVERLAP_LIST);
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanRevertRecurrence: caps the number of revert-commit detail lookups", async () => {
  // 12 revert commits, each detail non-overlapping ⇒ no finding; the global lookup cap (10) stops the scan.
  const many = Array.from({ length: 12 }, (_, i) => ({
    sha: `abc10${10 + i}`,
    commit: { message: 'Revert "x (#1)"' },
  }));
  const capMock = async (url) => {
    if (url.includes("/commits/")) {
      return jsonResponse({ files: [{ filename: "src/a.ts", patch: "@@ -100,1 +100,0 @@\n-x" }] });
    }
    return jsonResponse(many);
  };
  assert.deepEqual(await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), capMock), []);
});

test("scanRevertRecurrence: fails safe on a non-ok or throwing list fetch", async () => {
  resetExternalFetchCircuitBreakerForTest();
  assert.deepEqual(
    await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), async () => jsonResponse({}, 500)),
    [],
  );
  assert.deepEqual(
    await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), async () => {
      throw new Error("network");
    }),
    [],
  );
});

test("scanRevertRecurrence: fails safe when the revert-detail fetch fails", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const out = await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), async (url) =>
    url.includes("/commits/") ? jsonResponse({}, 500) : jsonResponse(OVERLAP_LIST),
  );
  assert.deepEqual(out, []);
});

test("scanRevertRecurrence: stops on an already-aborted signal", async () => {
  assert.deepEqual(
    await scanRevertRecurrence(req([{ path: "src/a.ts", patch: PR_PATCH }]), routed(OVERLAP_LIST, OVERLAP_DETAIL), {
      signal: AbortSignal.abort(),
    }),
    [],
  );
});

test("renderBrief emits a public-safe revert-recurrence block", () => {
  const { promptSection } = renderBrief({
    revertRecurrence: [
      { file: "src/a.ts", line: 11, revertShaPrefix: "abcdef1", revertedPr: 42 },
      { file: "src/b.ts", line: 5, revertShaPrefix: "1234567" },
    ],
  });
  assert.match(promptSection, /Revert recurrence/);
  assert.match(promptSection, /src\/a\.ts:11/);
  assert.match(promptSection, /abcdef1/);
  assert.match(promptSection, /revert of #42/);
  assert.match(promptSection, /src\/b\.ts:5/);
});

test("renderBrief omits the revert-recurrence block when there are no findings", () => {
  assert.equal(renderBrief({ revertRecurrence: [] }).promptSection, "");
});
