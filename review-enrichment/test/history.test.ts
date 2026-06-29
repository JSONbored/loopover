// Units for the author / change-area history analyzer (#1478). Kept in its own file (not enrichment.test.ts) so
// concurrent analyzer PRs don't collide on a shared test file. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepo,
  requirementTokens,
  classifyCoverage,
  collectRevertRefs,
  buildLinkedIssueAlignment,
  scanHistory,
} from "../dist/analyzers/history.js";
import { renderBrief } from "../dist/render.js";

// Minimal Response-like stubs (ok/status/json/text), matching the other analyzer tests.
const res = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const notOk = (status) => res({}, { ok: false, status });
const throwingFetch = async () => {
  throw new Error("network down");
};

// A tiny URL router so each test declares only the endpoints it exercises. Routes are matched in order; a string
// matches by substring, a RegExp by test(). Unmatched URLs 404 (so a stray call degrades rather than silently passing).
function router(routes) {
  return async (url) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (hit) return handler;
    }
    return notOk(404);
  };
}

const NOW = Date.parse("2026-06-29T00:00:00Z");

test("scanHistory: author track record for a repeat contributor", async () => {
  const fetchImpl = router([
    ["is%3Aunmerged", res({ total_count: 2 })], // closed-unmerged (checked first; its URL lacks is%3Amerged)
    ["is%3Amerged", res({ total_count: 7 })],
    ["/users/octocat", res({ created_at: "2020-01-01T00:00:00Z" })],
  ]);
  const out = await scanHistory(
    { repoFullName: "o/r", prNumber: 5, author: "octocat", githubToken: "t", files: [] },
    fetchImpl,
    { now: NOW },
  );
  assert.equal(out.length, 1);
  const a = out[0].author;
  assert.equal(a.priorMergedInRepo, 7);
  assert.equal(a.priorClosedInRepo, 2);
  assert.equal(a.firstTimeContributor, false);
  assert.ok(a.accountAgeDays > 2000);
  assert.equal(out[0].partial, false);
  assert.equal(out[0].linkedIssueAlignment, null);
});

test("scanHistory: flags a first-time contributor with account age", async () => {
  const fetchImpl = router([
    ["is%3Aunmerged", res({ total_count: 0 })],
    ["is%3Amerged", res({ total_count: 0 })],
    ["/users/newbie", res({ created_at: "2026-06-01T00:00:00Z" })],
  ]);
  const out = await scanHistory(
    { repoFullName: "o/r", prNumber: 1, author: "newbie", githubToken: "t", files: [] },
    fetchImpl,
    { now: NOW },
  );
  assert.equal(out[0].author.firstTimeContributor, true);
  assert.equal(out[0].author.accountAgeDays, 28);
  assert.equal(out[0].partial, false);
});

test("scanHistory: surfaces similar past PRs and marks a reverted one", async () => {
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const fetchImpl = router([
    ["is%3Aunmerged", res({ total_count: 0 })],
    ["is%3Amerged", res({ total_count: 1 })],
    ["/users/dev", res({ created_at: "2024-01-01T00:00:00Z" })],
    [
      "/commits?path=",
      res([
        { sha: shaA, commit: { message: 'Revert "add foo" (#10)' } },
        { sha: shaB, commit: { message: "add foo" } },
      ]),
    ],
    [new RegExp(`/commits/${shaA}/pulls`), res([{ number: 11, title: 'Revert "add foo" (#10)' }])],
    [new RegExp(`/commits/${shaB}/pulls`), res([{ number: 10, title: "add foo" }])],
  ]);
  const out = await scanHistory(
    {
      repoFullName: "o/r",
      prNumber: 5,
      author: "dev",
      githubToken: "t",
      files: [{ path: "src/foo.ts", status: "modified" }],
    },
    fetchImpl,
    { now: NOW },
  );
  const prs = out[0].similarPastPrs;
  const pr10 = prs.find((p) => p.number === 10);
  const pr11 = prs.find((p) => p.number === 11);
  assert.equal(pr10.outcome, "reverted");
  assert.equal(pr11.outcome, "merged");
  assert.deepEqual(pr10.overlapPaths, ["src/foo.ts"]);
});

test("scanHistory: excludes the current PR from similar past PRs", async () => {
  const shaA = "c".repeat(40);
  const fetchImpl = router([
    [/\/search\/issues/, res({ total_count: 0 })],
    ["/users/dev", res({ created_at: "2024-01-01T00:00:00Z" })],
    ["/commits?path=", res([{ sha: shaA, commit: { message: "touch foo" } }])],
    [new RegExp(`/commits/${shaA}/pulls`), res([{ number: 5, title: "the current PR" }])],
  ]);
  const out = await scanHistory(
    { repoFullName: "o/r", prNumber: 5, author: "dev", githubToken: "t", files: [{ path: "src/foo.ts" }] },
    fetchImpl,
    { now: NOW },
  );
  assert.deepEqual(out[0].similarPastPrs, []);
});

test("buildLinkedIssueAlignment: full / partial / none / absent", () => {
  const withDiff = (diff) => ({
    repoFullName: "o/r",
    prNumber: 1,
    linkedIssue: { number: 42, title: "add history analyzer enrichment" },
    diff,
  });
  assert.equal(buildLinkedIssueAlignment(withDiff("+history analyzer enrichment")).diffCovers, "full");
  assert.equal(buildLinkedIssueAlignment(withDiff("+only history here")).diffCovers, "partial");
  assert.equal(buildLinkedIssueAlignment(withDiff("+nothing relevant")).diffCovers, "none");
  assert.equal(buildLinkedIssueAlignment({ repoFullName: "o/r", prNumber: 1 }), null);
  const alignment = buildLinkedIssueAlignment(withDiff("+history analyzer enrichment"));
  assert.equal(alignment.issue, 42);
  assert.equal(alignment.statedRequirement, "add history analyzer enrichment");
});

test("scanHistory: no token still ships linked-issue alignment as a partial block", async () => {
  const out = await scanHistory(
    {
      repoFullName: "o/r",
      prNumber: 1,
      linkedIssue: { number: 42, title: "add history analyzer" },
      diff: "+history analyzer",
    },
    throwingFetch, // must NOT be called without a token
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].author, null);
  assert.equal(out[0].partial, true);
  assert.equal(out[0].linkedIssueAlignment.diffCovers, "full");
  assert.deepEqual(out[0].similarPastPrs, []);
});

test("scanHistory: returns [] when there is no token and no linked issue", async () => {
  assert.deepEqual(
    await scanHistory({ repoFullName: "o/r", prNumber: 1, files: [] }, throwingFetch),
    [],
  );
});

test("scanHistory: a rate-limited GitHub query degrades the block (partial) without throwing", async () => {
  const out = await scanHistory(
    {
      repoFullName: "o/r",
      prNumber: 1,
      author: "dev",
      githubToken: "t",
      files: [],
      linkedIssue: { number: 9, title: "do the thing properly" },
    },
    router([
      ["/search/issues", notOk(403)],
      ["/users/", notOk(403)],
    ]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].partial, true);
  assert.equal(out[0].author.priorMergedInRepo, 0);
  assert.equal(out[0].author.firstTimeContributor, true); // counts defaulted to 0 on failure
  assert.equal(out[0].linkedIssueAlignment.issue, 9); // the rest of the block still ships
});

test("scanHistory: a thrown GitHub fetch degrades safely", async () => {
  const out = await scanHistory(
    {
      repoFullName: "o/r",
      prNumber: 1,
      author: "dev",
      githubToken: "t",
      files: [{ path: "src/x.ts", status: "modified" }],
    },
    throwingFetch,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].partial, true);
  assert.deepEqual(out[0].similarPastPrs, []);
});

test("scanHistory: an unsafe repoFullName is rejected before any fetch", async () => {
  const out = await scanHistory(
    { repoFullName: "o/r/../x", prNumber: 1, author: "dev", githubToken: "t", files: [] },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("requirementTokens drops short words and stopwords", () => {
  assert.deepEqual(requirementTokens("Add the History Analyzer to enrichment"), [
    "history",
    "analyzer",
    "enrichment",
  ]);
});

test("classifyCoverage thresholds", () => {
  assert.equal(classifyCoverage("history analyzer enrichment", "history analyzer enrichment"), "full");
  assert.equal(classifyCoverage("history analyzer enrichment", "history only"), "partial");
  assert.equal(classifyCoverage("history analyzer enrichment", "unrelated"), "none");
  assert.equal(classifyCoverage("", "anything"), "none");
});

test("collectRevertRefs only collects from revert messages", () => {
  const s1 = new Set();
  collectRevertRefs('Revert "x" (#10) and #12', s1);
  assert.deepEqual([...s1].sort((a, b) => a - b), [10, 12]);
  const s2 = new Set();
  collectRevertRefs("normal commit referencing #5", s2);
  assert.equal(s2.size, 0);
  collectRevertRefs(undefined, s2);
  assert.equal(s2.size, 0);
});

test("parseRepo rejects unsafe names", () => {
  assert.deepEqual(parseRepo("o/r"), { owner: "o", repo: "r" });
  assert.equal(parseRepo("o"), null);
  assert.equal(parseRepo("o/r/x"), null);
  assert.equal(parseRepo("../x"), null);
  assert.equal(parseRepo("o/.."), null);
});

test("renderBrief emits a public-safe history block", () => {
  const { promptSection } = renderBrief({
    history: [
      {
        author: { priorMergedInRepo: 7, priorClosedInRepo: 2, accountAgeDays: 1500, firstTimeContributor: false },
        similarPastPrs: [{ number: 10, title: "add foo", outcome: "reverted", overlapPaths: ["src/foo.ts"] }],
        linkedIssueAlignment: { issue: 42, statedRequirement: "add the history analyzer", diffCovers: "partial" },
        partial: false,
      },
    ],
  });
  assert.match(promptSection, /Author & change-area history/);
  assert.match(promptSection, /7 merged \/ 2 closed/);
  assert.match(promptSection, /previously changed in #10 \(reverted\)/);
  assert.match(promptSection, /Linked issue #42 coverage: \*\*partial\*\*/);
});

test("renderBrief notes a partial history block and omits an empty one", () => {
  const partialOut = renderBrief({
    history: [
      {
        author: null,
        similarPastPrs: [],
        linkedIssueAlignment: { issue: 1, statedRequirement: "x", diffCovers: "none" },
        partial: true,
      },
    ],
  });
  assert.match(partialOut.promptSection, /partial — some history/);
  const emptyOut = renderBrief({
    history: [{ author: null, similarPastPrs: [], linkedIssueAlignment: null, partial: true }],
  });
  assert.equal(emptyOut.promptSection, "");
});
