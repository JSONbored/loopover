// Units for the unused-export analyzer (#2025). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDeadOnArrivalFromSearch,
  scanUnusedExport,
} from "../dist/analyzers/unused-export.js";
import { renderBrief } from "../dist/render.js";

const searchJson = (total, items, incomplete = false) =>
  JSON.stringify({ total_count: total, incomplete_results: incomplete, items });

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

test("isDeadOnArrivalFromSearch: one hit in the declaring file is dead; external or multiple hits are alive", () => {
  assert.equal(
    isDeadOnArrivalFromSearch("src/util.ts", {
      total_count: 1,
      items: [{ path: "src/util.ts" }],
    }),
    true,
  );
  assert.equal(
    isDeadOnArrivalFromSearch("src/util.ts", {
      total_count: 2,
      items: [{ path: "src/util.ts" }, { path: "src/util.ts" }],
    }),
    false,
  );
  assert.equal(
    isDeadOnArrivalFromSearch("src/util.ts", {
      total_count: 2,
      items: [{ path: "src/util.ts" }, { path: "src/app.ts" }],
    }),
    false,
  );
  assert.equal(isDeadOnArrivalFromSearch("src/util.ts", { total_count: 0, items: [] }), null);
  assert.equal(
    isDeadOnArrivalFromSearch("src/util.ts", { total_count: 1, incomplete_results: true, items: [] }),
    null,
  );
});

test("scanUnusedExport: flags a newly added export with only its declaration in search results", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export function orphanHelper() {}"].join("\n");
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) {
      return new Response(searchJson(1, [{ path: "src/util.ts" }]), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  const findings = await scanUnusedExport(
    req([{ path: "src/util.ts", status: "added", patch }]),
    fetchFn,
  );
  assert.deepEqual(findings, [{ file: "src/util.ts", line: 1, symbol: "orphanHelper" }]);
  const brief = renderBrief({ unusedExport: findings }).promptSection;
  assert.match(brief, /Unused exports/i);
  assert.match(brief, /orphanHelper/);
});

test("scanUnusedExport: does not flag when search finds a reference in another file", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export const shared = 1;"].join("\n");
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) {
      return new Response(
        searchJson(2, [{ path: "src/util.ts" }, { path: "src/app.ts" }]),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  };
  const findings = await scanUnusedExport(
    req([{ path: "src/util.ts", status: "added", patch }]),
    fetchFn,
  );
  assert.deepEqual(findings, []);
});

test("scanUnusedExport: enforces the maxSearches cap", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export function fn() {}"].join("\n");
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `src/file${i}.ts`,
    status: "added",
    patch: patch.replace("fn", `fn${i}`),
  }));
  let searches = 0;
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) {
      searches += 1;
      return new Response(searchJson(1, [{ path: "src/file0.ts" }]), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  await scanUnusedExport(req(files), fetchFn);
  assert.equal(searches, 10);
});

test("scanUnusedExport: returns no findings without a GitHub token", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export function lonely() {}"].join("\n");
  const findings = await scanUnusedExport(
    req([{ path: "src/util.ts", status: "added", patch }], { githubToken: undefined }),
    async () => new Response("", { status: 500 }),
  );
  assert.deepEqual(findings, []);
});
