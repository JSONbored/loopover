// Units for the stale-branch signal analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs don't
// collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateStaleBranch,
  scanStaleBranch,
} from "../dist/analyzers/stale-branch.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "test-token",
  headSha: "headsha0000000000000000000000000000000000",
  ...extra,
});

const routedFetch = ({ defaultBranch, behindBy, status }) => async (url) => {
  if (url.endsWith("/repos/octo/repo")) {
    return defaultBranch === null ? jsonResponse({}, 404) : jsonResponse({ default_branch: defaultBranch });
  }
  if (url.includes("/compare/")) {
    return behindBy === null ? jsonResponse({}, 404) : jsonResponse({ status, behind_by: behindBy });
  }
  return jsonResponse({}, 404);
};

test("evaluateStaleBranch: flags a PR at/over the behind-by threshold", () => {
  const findings = evaluateStaleBranch("main", { status: "behind", behind_by: 100 });
  assert.deepEqual(findings, [{ defaultBranch: "main", behindBy: 100 }]);
});

test("evaluateStaleBranch: a PR just under the threshold is not flagged", () => {
  assert.deepEqual(evaluateStaleBranch("main", { status: "behind", behind_by: 99 }), []);
});

test("evaluateStaleBranch: a PR that is not behind at all is not flagged", () => {
  assert.deepEqual(evaluateStaleBranch("main", { status: "identical", behind_by: 0 }), []);
  assert.deepEqual(evaluateStaleBranch("main", { status: "ahead", behind_by: 0 }), []);
});

test("evaluateStaleBranch: a missing/non-numeric behind_by fails closed (no finding)", () => {
  assert.deepEqual(evaluateStaleBranch("main", {}), []);
  assert.deepEqual(evaluateStaleBranch("main", { behind_by: undefined }), []);
  assert.deepEqual(evaluateStaleBranch("main", { behind_by: "100" }), []);
  assert.deepEqual(evaluateStaleBranch("main", { behind_by: Number.NaN }), []);
  assert.deepEqual(evaluateStaleBranch("main", { behind_by: -5 }), []);
});

test("scanStaleBranch: resolves a finding from the repo + compare API responses", async () => {
  const findings = await scanStaleBranch(
    req(),
    routedFetch({ defaultBranch: "main", behindBy: 150, status: "behind" }),
  );
  assert.deepEqual(findings, [{ defaultBranch: "main", behindBy: 150 }]);
  const brief = renderBrief({ staleBranch: findings }).promptSection;
  assert.match(brief, /150 commits behind/);
  assert.match(brief, /main/);
});

test("scanStaleBranch: a branch well within range yields no finding", async () => {
  const findings = await scanStaleBranch(
    req(),
    routedFetch({ defaultBranch: "main", behindBy: 3, status: "behind" }),
  );
  assert.deepEqual(findings, []);
});

test("scanStaleBranch: requests the repo endpoint then the compare endpoint against the default branch", async () => {
  const urls = [];
  await scanStaleBranch(req(), async (url) => {
    urls.push(url);
    if (url.endsWith("/repos/octo/repo")) return jsonResponse({ default_branch: "trunk" });
    return jsonResponse({ status: "behind", behind_by: 0 });
  });
  assert.equal(urls[0], "https://api.github.com/repos/octo/repo");
  assert.match(urls[1], /^https:\/\/api\.github\.com\/repos\/octo\/repo\/compare\/trunk\.\.\.headsha0+$/);
});

test("scanStaleBranch: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanStaleBranch(
    req({ githubToken: undefined }),
    routedFetch({ defaultBranch: "main", behindBy: 150, status: "behind" }),
  );
  assert.deepEqual(findings, []);
});

test("scanStaleBranch: no head SHA → skipped (no finding, no throw)", async () => {
  const findings = await scanStaleBranch(
    req({ headSha: undefined }),
    routedFetch({ defaultBranch: "main", behindBy: 150, status: "behind" }),
  );
  assert.deepEqual(findings, []);
});

test("scanStaleBranch: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanStaleBranch(
    req({ repoFullName: "not-a-valid-slug" }),
    routedFetch({ defaultBranch: "main", behindBy: 150, status: "behind" }),
  );
  assert.deepEqual(findings, []);
});

test("scanStaleBranch: the repo-info fetch failing yields no finding (and never calls compare)", async () => {
  let compareCalled = false;
  const findings = await scanStaleBranch(req(), async (url) => {
    if (url.includes("/compare/")) compareCalled = true;
    return jsonResponse({}, 404);
  });
  assert.deepEqual(findings, []);
  assert.equal(compareCalled, false);
});

test("scanStaleBranch: a repo response missing default_branch yields no finding", async () => {
  const findings = await scanStaleBranch(req(), async (url) => {
    if (url.endsWith("/repos/octo/repo")) return jsonResponse({});
    return jsonResponse({ status: "behind", behind_by: 150 });
  });
  assert.deepEqual(findings, []);
});

test("scanStaleBranch: the compare fetch failing yields no finding", async () => {
  const findings = await scanStaleBranch(
    req(),
    routedFetch({ defaultBranch: "main", behindBy: null }),
  );
  assert.deepEqual(findings, []);
});
