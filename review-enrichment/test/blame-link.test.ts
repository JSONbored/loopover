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
});

test("scanBlameLink: resolves the originating PR for a modified line", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(40) }], { baseSha: "base123" }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 42 }),
  );
  assert.deepEqual(findings, [
    { file: "src/app.ts", line: 41, introducedByShaPrefix: "abcdef123456", introducedByPr: 42 },
  ]);
  // and it renders into the brief with the PR reference
  const brief = renderBrief({ blameLink: findings }).promptSection;
  assert.match(brief, /blame → originating PR/i);
  assert.match(brief, /#42/);
});

test("scanBlameLink: a commit with no associated PR still surfaces the SHA prefix", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(1) }]),
    routedFetch({ commitSha: "deadbeefcafebabe", prNumber: null }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].introducedByShaPrefix, "deadbeefcafe");
  assert.equal(findings[0].introducedByPr, undefined);
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

test("scanBlameLink: caps the number of files probed", async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({
    path: `src/f${i}.ts`,
    status: "modified",
    patch: modifyPatch(i + 1),
  }));
  const findings = await scanBlameLink(req(files), routedFetch({ commitSha: "abcdef1234567890", prNumber: 9 }));
  assert.equal(findings.length, 6); // MAX_FILES_PROBED
});

test("scanBlameLink: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanBlameLink(
    req([{ path: "src/app.ts", status: "modified", patch: modifyPatch(2) }], { githubToken: undefined }),
    routedFetch({ commitSha: "abcdef1234567890", prNumber: 1 }),
  );
  assert.deepEqual(findings, []);
});
