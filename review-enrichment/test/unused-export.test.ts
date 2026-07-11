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

test("scanUnusedExport: uses the analysis-context fetchText for file content when supplied, instead of the bare fetch path", async () => {
  // #4824: the file-content fetch now goes through the shared boundedFetchText helper, which prefers
  // options.analysis.fetchText (mirrors duplication-delta.ts's own fetchFileAtHead) when an AnalysisContext is
  // supplied — the raw fetchFn passed as the second positional arg must never be invoked in that case. The head
  // content references the export locally, so referencesSymbolInSource short-circuits before any search is
  // attempted — analysis.fetchJson is never called either.
  const patch = ["@@ -0,0 +1,2 @@", "+export function helper() {}", "+helper();"].join("\n");
  const head = "export function helper() {}\nhelper();";
  let fetchTextCalls = 0;
  const analysis = {
    fetchText: async (_url, _opts) => {
      fetchTextCalls += 1;
      return { ok: true, status: 200, data: head, bytes: head.length, elapsedMs: 0, endpointCategory: "github-contents" };
    },
    fetchJson: async () => {
      throw new Error("fetchJson should not be called: the local reference short-circuits before any search");
    },
  };
  const findings = await scanUnusedExport(
    req([{ path: "src/util.ts", status: "added", patch }]),
    async () => {
      throw new Error("bare fetch should not be used when analysis.fetchText is supplied");
    },
    { analysis },
  );
  assert.equal(fetchTextCalls, 1);
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
