// Units for the unused-export analyzer (#2025). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDeadOnArrivalFromSearch,
  referencesSymbolInSource,
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

test("isDeadOnArrivalFromSearch: zero indexed hits is dead; external or multiple hits are alive", () => {
  assert.equal(isDeadOnArrivalFromSearch("src/util.ts", { total_count: 0, items: [] }), true);
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
      items: [{ path: "src/util.ts" }, { path: "src/app.ts" }],
    }),
    false,
  );
  assert.equal(
    isDeadOnArrivalFromSearch("src/util.ts", { total_count: 1, incomplete_results: true, items: [] }),
    null,
  );
});

test("referencesSymbolInSource: ignores the declaration line but catches same-file uses", () => {
  const src = ["export function helper() {}", "helper();", "export const other = 1;"].join("\n");
  assert.equal(referencesSymbolInSource(src, "helper", 1), true);
  assert.equal(referencesSymbolInSource(src, "other", 3), false);
});

test("scanUnusedExport: flags a newly added export absent from the default-branch index", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export function orphanHelper() {}"].join("\n");
  const head = "export function orphanHelper() {}";
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return new Response(head, { status: 200 });
    if (url.includes("/search/code")) {
      return new Response(searchJson(0, []), { status: 200 });
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
    if (url.includes("/contents/")) return new Response("export const shared = 1;", { status: 200 });
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

test("scanUnusedExport: does not flag when the head file uses the export locally", async () => {
  const patch = ["@@ -0,0 +1,2 @@", "+export function helper() {}", "+helper();"].join("\n");
  const head = "export function helper() {}\nhelper();";
  const fetchFn = async (url) => {
    if (url.includes("/contents/")) return new Response(head, { status: 200 });
    if (url.includes("/search/code")) return new Response(searchJson(0, []), { status: 200 });
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
    if (url.includes("/contents/")) {
      const match = /file(\d+)\.ts/.exec(url);
      const idx = match ? match[1] : "0";
      return new Response(`export function fn${idx}() {}`, { status: 200 });
    }
    if (url.includes("/search/code")) {
      searches += 1;
      return new Response(searchJson(0, []), { status: 200 });
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
