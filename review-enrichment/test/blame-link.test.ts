// Units for the blame-to-PR regression linker (#2034). Own file (not enrichment.test.ts) so concurrent analyzer
// PRs don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  firstTouchedOldLine,
  scanBlameLink,
} from "../dist/analyzers/blame-link.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

// A unified-diff patch that modifies an existing line: header at `oldStart`, one context line, one deletion.
const modifyPatch = (oldStart) => `@@ -${oldStart},3 +${oldStart},3 @@\n unchanged\n-old code\n+new code\n`;

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  files,
  ...extra,
});

// A fetch stub that routes by URL: the commit→PR association endpoint (…/pulls) vs the path-history endpoint.
const routedFetch = ({ commitSha, prNumber }) => async (url) => {
  if (url.includes("/pulls")) return jsonResponse(prNumber === null ? [] : [{ number: prNumber }]);
  if (url.includes("/commits?")) return jsonResponse(commitSha === null ? [] : [{ sha: commitSha }]);
  return jsonResponse([], 404);
};

test("firstTouchedOldLine: reports the first modified/deleted old-file line, null for pure additions", () => {
  assert.equal(firstTouchedOldLine("@@ -10,3 +10,4 @@\n keep\n-drop\n+add\n"), 11); // context 10, deletion 11
  assert.equal(firstTouchedOldLine("@@ -5,2 +5,2 @@\n-first\n+repl\n"), 5); // deletion is the first hunk line
  assert.equal(firstTouchedOldLine("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n"), null); // pure addition → nothing to blame
  assert.equal(firstTouchedOldLine("no hunk header here"), null);
  // The `\ No newline at end of file` marker is metadata — it must not advance the old-line counter.
  assert.equal(firstTouchedOldLine("@@ -7,2 +7,1 @@\n keep\n-gone\n\\ No newline at end of file\n"), 8);
  // Only space-prefixed context advances: a malformed/extended line must NOT be counted as an old-file line.
  assert.equal(firstTouchedOldLine("@@ -5,2 +5,2 @@\nmalformed no-prefix line\n-x\n"), 5); // not 6
});

test("scanBlameLink: resolves the last PR to touch a modified file", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(40) }], { baseSha: "base123" }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 42 }),
  );
  assert.deepEqual(findings, [
    { file: "src/app.ts", line: 41, lastTouchedByShaPrefix: "abcdef123456", lastTouchedByPr: 42 },
  ]);
  // and it renders into the brief as file-level "last touched", not a line-origin claim
  const brief = renderBrief({ blameLink: findings }).promptSection;
  assert.match(brief, /last touched by/i);
  assert.match(brief, /#42/);
});

test("scanBlameLink: file-level only — it does NOT attribute the last-touch PR to the changed line's origin", async () => {
  // The file's latest base commit (PR #99) touched a DIFFERENT region than the line this PR changes (old line 51).
  // The finding must report #99 as the file's last toucher and line 51 only as a change POINTER — never a claim
  // that #99 introduced line 51. (Reviewer's false-attribution regression case.)
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: "@@ -50,3 +50,3 @@\n keep\n-line51\n+new\n" }], { baseSha: "b" }),
    routedFetch({ commitSha: "aaaaaaaaaaaabbbb", prNumber: 99 }),
  );
  assert.deepEqual(findings, [
    { file: "src/app.ts", line: 51, lastTouchedByShaPrefix: "aaaaaaaaaaaa", lastTouchedByPr: 99 },
  ]);
  // The finding carries no "introducedBy"/origin field for the line — attribution is file-level by construction.
  assert.equal("introducedByPr" in findings[0], false);
  assert.match(renderBrief({ blameLink: findings }).promptSection, /file-level context/i);
});

test("scanBlameLink: reports the OLD-file line on a shifted hunk, and renders it as an old line", async () => {
  const findings = await scanBlameLink(
    // hunk shifted: old side starts at 20, new side at 25 — the blamed coordinate is the OLD line, not the new one
    req([{ path: "src/app.ts", status: "modified", patch: "@@ -20,3 +25,3 @@\n keep\n-old\n+new\n" }], { baseSha: "b" }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 5 }),
  );
  assert.equal(findings[0].line, 21); // old 20 (header) + 1 context; NOT the new-side 26
  assert.match(renderBrief({ blameLink: findings }).promptSection, /old line 21/);
});

test("scanBlameLink: a removed file is blamed via its path even without a patch", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/gone.ts", status: "removed" }], { baseSha: "b" }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 8 }),
  );
  assert.deepEqual(findings, [
    { file: "src/gone.ts", line: 1, lastTouchedByShaPrefix: "abcdef123456", lastTouchedByPr: 8 },
  ]);
});

test("scanBlameLink: a commit with no associated PR still surfaces the SHA prefix", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(1) }]),
    routedFetch({ commitSha: "deadbeefcafebabe", prNumber: null }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].lastTouchedByShaPrefix, "deadbeefcafe");
  assert.equal(findings[0].lastTouchedByPr, undefined);
});

test("scanBlameLink: an unresolvable line (no prior commit) yields no finding", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(3) }]),
    routedFetch({ commitSha: null, prNumber: null }),
  );
  assert.deepEqual(findings, []);
});

test("scanBlameLink: pure-addition and added files are skipped (nothing to blame)", async () => {
  const findings = await scanBlameLink(
    req([
      { path: "new.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
      { path: "onlyadds.ts", status: "modified", patch: "@@ -3,0 +4,2 @@\n+x\n+y\n" },
    ]),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 7 }),
  );
  assert.deepEqual(findings, []);
});

test("scanBlameLink: caps probed files and total lookups, leaving later files untouched", async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `src/f${i}.ts`,
    status: "modified",
    patch: modifyPatch(i + 1),
  }));
  let calls = 0;
  const probedPaths = new Set();
  const countingFetch = async (url) => {
    calls += 1;
    const path = new URL(url).searchParams.get("path");
    if (path) probedPaths.add(path);
    if (url.includes("/pulls")) return jsonResponse([{ number: 9 }]);
    if (url.includes("/commits?")) return jsonResponse([{ sha: "abcdef1234567890" }]);
    return jsonResponse([], 404);
  };
  const findings = await scanBlameLink(req(files), countingFetch);
  assert.equal(findings.length, 6); // MAX_FILES_PROBED
  assert.equal(calls, 12); // 6 files × (1 commit-list + 1 pulls) = MAX_LOOKUPS; not one more
  assert.deepEqual([...probedPaths].sort(), ["src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts", "src/f5.ts"]); // f6..f9 never probed
});

test("scanBlameLink: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(2) }], { githubToken: undefined }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 1 }),
  );
  assert.deepEqual(findings, []);
});
