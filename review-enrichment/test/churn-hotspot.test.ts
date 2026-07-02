// Units for the churn-hotspot analyzer (#1513). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFixCommit,
  summarizeChurn,
  isHotspot,
  scanChurnHotspot,
} from "../dist/analyzers/churn-hotspot.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });
// n commit items; every `fixEvery`-th one is a fix commit (fixEvery 0 = none).
const commits = (n, fixEvery = 0) =>
  Array.from({ length: n }, (_, i) => ({
    commit: { message: fixEvery && i % fixEvery === 0 ? `fix: bug ${i}` : `feat: thing ${i}` },
  }));
const req = (files) => ({ repoFullName: "octo/repo", prNumber: 1, githubToken: "ghp_test", files });

test("isFixCommit: matches defect-correcting subjects, not lookalikes", () => {
  for (const m of ["fix: crash", "fixed the bug", "fixes #12", "bugfix in parser", "hotfix prod", "revert bad change", "regression in build", "fixing a flake"])
    assert.equal(isFixCommit(m), true, m);
  for (const m of ["feat: add x", "refactor prefix handling", "update fixtures", "docs: suffix note"])
    assert.equal(isFixCommit(m), false, m);
});

test("isFixCommit: classifies on the subject line only, not the body", () => {
  assert.equal(isFixCommit("feat: thing\n\nthis also reverts an idea"), false);
});

test("summarizeChurn + isHotspot: counts, fraction, and thresholds", () => {
  const s = summarizeChurn(commits(10, 2)); // 5 of 10 are fixes
  assert.deepEqual([s.commitCount, s.fixCount, s.fixFraction], [10, 5, 0.5]);
  assert.equal(isHotspot({ commitCount: 10, fixFraction: 0.5 }), true);
  assert.equal(isHotspot({ commitCount: 4, fixFraction: 0.9 }), false); // too few commits
  assert.equal(isHotspot({ commitCount: 20, fixFraction: 0.1 }), false); // too few fixes
});

test("scanChurnHotspot: flags a high-churn, high-fix file", async () => {
  const findings = await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => jsonResponse(commits(12, 2)));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "src/a.ts");
  assert.equal(findings[0].commitCount, 12);
  assert.equal(findings[0].fixCount, 6);
  assert.equal(findings[0].windowDays, 90);
  assert.equal(findings[0].capped, false);
});

test("scanChurnHotspot: a low-churn or low-fix file is not flagged", async () => {
  assert.deepEqual(await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => jsonResponse(commits(5, 1))), []); // < 8 commits
  assert.deepEqual(await scanChurnHotspot(req([{ path: "src/b.ts" }]), async () => jsonResponse(commits(20, 0))), []); // no fixes
});

test("scanChurnHotspot: marks the count capped when the page is full", async () => {
  const f = await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => jsonResponse(commits(100, 2)));
  assert.equal(f.length, 1);
  assert.equal(f[0].capped, true);
});

test("scanChurnHotspot: skips lockfiles, binaries, and newly-added files without fetching", async () => {
  let called = false;
  const out = await scanChurnHotspot(
    req([{ path: "package-lock.json" }, { path: "assets/logo.png" }, { path: "src/new.ts", status: "added" }]),
    async () => {
      called = true;
      return jsonResponse(commits(50, 2));
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanChurnHotspot: requires a github token and a valid repo slug", async () => {
  assert.deepEqual(await scanChurnHotspot({ repoFullName: "octo/repo", prNumber: 1, files: [{ path: "src/a.ts" }] }, async () => jsonResponse(commits(20, 2))), []);
  assert.deepEqual(await scanChurnHotspot({ repoFullName: "bad slug/x!", prNumber: 1, githubToken: "t", files: [{ path: "src/a.ts" }] }, async () => jsonResponse(commits(20, 2))), []);
});

test("scanChurnHotspot: rejects multi-segment repo slugs without fetching", async () => {
  let called = false;
  const out = await scanChurnHotspot(
    { repoFullName: "octo/repo/extra", prNumber: 1, githubToken: "ghp_test", files: [{ path: "src/a.ts" }] },
    async () => {
      called = true;
      return jsonResponse(commits(20, 2));
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanChurnHotspot: fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => jsonResponse({}, 500)), []);
  assert.deepEqual(
    await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => {
      throw new Error("network");
    }),
    [],
  );
});

test("scanChurnHotspot: stops on an already-aborted signal", async () => {
  assert.deepEqual(
    await scanChurnHotspot(req([{ path: "src/a.ts" }]), async () => jsonResponse(commits(20, 2)), { signal: AbortSignal.abort() }),
    [],
  );
});

test("renderBrief emits a public-safe churn-hotspot block", () => {
  const { promptSection } = renderBrief({
    churnHotspot: [{ file: "src/a.ts", commitCount: 100, fixCount: 40, windowDays: 90, capped: true }],
  });
  assert.match(promptSection, /Churn hotspots/);
  assert.match(promptSection, /src\/a\.ts/);
  assert.match(promptSection, /100\+ commits in 90d/);
  assert.match(promptSection, /40 fix\/revert/);
});
