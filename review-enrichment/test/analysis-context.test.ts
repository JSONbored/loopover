// Units for the shared REES analysis context (#1810). Kept separate so future analyzer PRs can add their own
// migrations without fighting over the broad enrichment test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectAddedLines,
  createAnalysisContext,
  filesHaveAddedLines,
} from "../dist/analysis-context.js";
import { planAnalyzers } from "../dist/scheduler.js";
import {
  queryOsvBatch,
  scanDependencyChanges,
} from "../dist/analyzers/dependency-scan.js";

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

test("collectAddedLines keeps added lines whose content starts with ++ (rendered +++x)", () => {
  // git renders an added line whose content is `++x` as `+` + `++x` = `+++x`; the header guard must match only
  // the real `+++ b/file` header (marker run + space), or the line is dropped and the ones after it mis-numbered.
  const files = [
    {
      path: "src/inc.ts",
      patch: ["@@ -1,0 +1,2 @@", "+++x", "+const y = 1;"].join("\n"),
    },
  ];

  assert.deepEqual(
    collectAddedLines(files).map((added) => [added.line, added.text]),
    [
      [1, "++x"],
      [2, "const y = 1;"],
    ],
  );
  assert.equal(
    filesHaveAddedLines([{ path: "src/inc.ts", patch: "@@ -1,0 +1,1 @@\n+++x" }]),
    true,
  );
});

test("collectAddedLines does not let a no-newline marker skew line numbers", () => {
  // `\ No newline at end of file` is not a new-file line; advancing past it would cite every
  // subsequent added line one too high (same class as the iac-misconfig / redos regression).
  const files = [
    {
      path: "src/app.ts",
      patch: [
        "@@ -1,1 +1,2 @@",
        "-const x = 1;",
        "\\ No newline at end of file",
        "+const x = 1;",
        "+const y = 2;",
      ].join("\n"),
    },
  ];
  assert.deepEqual(
    collectAddedLines(files).map((added) => [added.line, added.text]),
    [
      [1, "const x = 1;"],
      [2, "const y = 2;"],
    ],
  );
});

test("createAnalysisContext parses common PR state once", () => {
  let now = 130;
  const syntheticGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  const context = createAnalysisContext(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 1810,
      headSha: "abcdef1234567890",
      files: [
        {
          path: "src/config.ts",
          patch: [
            "@@ -2,2 +2,3 @@",
            " const safe = true;",
            "-const oldToken = null;",
            `+const token = "${syntheticGithubToken}";`,
          ].join("\n"),
        },
        {
          path: "package.json",
          patch: [
            "@@ -5,2 +5,2 @@",
            '-    "lodash": "^4.17.20",',
            '+    "lodash": "^4.17.21",',
          ].join("\n"),
        },
      ],
    },
    { startedAtMs: 100, deadlineMs: 250, now: () => now },
  );

  assert.deepEqual(context.repo, {
    owner: "JSONbored",
    repo: "gittensory",
    fullName: "JSONbored/gittensory",
    prNumber: 1810,
    headSha: "abcdef1234567890",
  });
  assert.deepEqual(context.changedFilePaths, ["src/config.ts", "package.json"]);
  assert.deepEqual(context.dependencyManifestPaths, ["package.json"]);
  assert.deepEqual(context.patchHunks.map((hunk) => [hunk.file, hunk.newStart]), [
    ["src/config.ts", 2],
    ["package.json", 5],
  ]);
  assert.deepEqual(
    context.addedLines.map((line) => [line.file, line.line, line.text]),
    [
      ["src/config.ts", 3, `const token = "${syntheticGithubToken}";`],
      ["package.json", 5, '    "lodash": "^4.17.21",'],
    ],
  );

  const limits = {
    maxManifestFiles: 20,
    maxPatchLinesPerFile: 500,
    maxDependencyQueries: 25,
  };
  const firstChanges = context.dependencyChanges(limits);
  const secondChanges = context.dependencyChanges(limits);
  assert.strictEqual(secondChanges, firstChanges);
  assert.deepEqual(firstChanges, [
    {
      ecosystem: "npm",
      package: "lodash",
      from: "4.17.20",
      to: "4.17.21",
    },
  ]);

  now = 175;
  assert.equal(context.remainingMs(250), 75);
  assert.deepEqual(context.snapshotMetrics(), {
    cacheHits: 1,
    cacheMisses: 1,
    externalCallsByCategory: {},
    skippedWorkByCategory: {},
    cappedWorkByCategory: {},
    analysisElapsedMs: 75,
  });
});

test("request cache de-dupes in-flight external lookups and records safe metrics", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  let loads = 0;
  const load = async () => {
    loads += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true };
  };

  const [first, second] = await Promise.all([
    context.cachedExternalCall("github commit/pulls", "commit:abc123", load),
    context.cachedExternalCall("github commit/pulls", "commit:abc123", load),
  ]);

  assert.equal(loads, 1);
  assert.strictEqual(first, second);
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, {
    github_commit_pulls: 1,
  });
  assert.equal(context.snapshotMetrics().cacheMisses, 1);
  assert.equal(context.snapshotMetrics().cacheHits, 1);
});

test("request cache preserves category and key boundaries", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  let loads = 0;

  const first = await context.cachedExternalCall("a:b", "c", async () => {
    loads += 1;
    return "category-with-colon";
  });
  const second = await context.cachedExternalCall("a", "b:c", async () => {
    loads += 1;
    return "key-with-colon";
  });
  const repeatedFirst = await context.cachedExternalCall("a:b", "c", async () => {
    throw new Error("cache miss");
  });
  const repeatedSecond = await context.cachedExternalCall("a", "b:c", async () => {
    throw new Error("cache miss");
  });

  assert.equal(first, "category-with-colon");
  assert.equal(second, "key-with-colon");
  assert.equal(repeatedFirst, first);
  assert.equal(repeatedSecond, second);
  assert.equal(loads, 2);
  assert.equal(context.cache.size, 2);
  assert.equal(context.snapshotMetrics().cacheMisses, 2);
  assert.equal(context.snapshotMetrics().cacheHits, 2);
});

test("scanDependencyChanges batches and de-dupes OSV package lookups inside one request", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  let fetchCalls = 0;
  let queryCount = 0;
  const fetchImpl = async (_url, init = {}) => {
    fetchCalls += 1;
    const body = JSON.parse(String(init.body));
    queryCount = body.queries.length;
    return jsonResponse({
      results: [
        {
          vulns: [
            {
              id: "GHSA-test",
              summary: "test advisory",
              database_specific: { severity: "HIGH" },
            },
          ],
        },
      ],
    });
  };
  const duplicateChanges = [
    { ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" },
    { ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" },
  ];

  const findings = await scanDependencyChanges(duplicateChanges, fetchImpl, {
    analysis: context,
    limits: { maxDependencyQueries: 25 },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(queryCount, 1);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].cves[0].id, "GHSA-test");
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, { "osv-direct-querybatch": 1 });
  assert.equal(context.snapshotMetrics().cacheMisses, 1);
  assert.equal(context.snapshotMetrics().cacheHits, 0);
});

test("scanDependencyChanges chunks OSV batch lookups before fallback is needed", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  const batchSizes = [];
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.osv.dev/v1/querybatch");
    const body = JSON.parse(String(init.body));
    batchSizes.push(body.queries.length);
    return jsonResponse({
      results: body.queries.map((query, index) => ({
        vulns:
          query.package.name === "pkg-10" && index === 0
            ? [
                {
                  id: "GHSA-chunked",
                  summary: "chunked advisory",
                  database_specific: { severity: "HIGH" },
                },
              ]
            : [],
      })),
    });
  };
  const changes = Array.from({ length: 12 }, (_, index) => ({
    ecosystem: "npm",
    package: `pkg-${index}`,
    from: null,
    to: "1.0.0",
  }));

  const findings = await scanDependencyChanges(changes, fetchImpl, {
    analysis: context,
    limits: { maxDependencyQueries: 25 },
  });

  assert.deepEqual(batchSizes, [10, 2]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "pkg-10");
  assert.equal(findings[0].cves[0].id, "GHSA-chunked");
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, {
    "osv-direct-querybatch": 2,
  });
});

test("queryOsvBatch honors maxDependencyQueries for direct callers", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  const batchSizes = [];
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.osv.dev/v1/querybatch");
    const body = JSON.parse(String(init.body));
    batchSizes.push(body.queries.length);
    return jsonResponse({
      results: body.queries.map(() => ({ vulns: [] })),
    });
  };
  const changes = Array.from({ length: 25 }, (_, index) => ({
    ecosystem: "npm",
    package: `pkg-${index}`,
    from: null,
    to: "1.0.0",
  }));

  const cvesByKey = await queryOsvBatch(changes, fetchImpl, undefined, {
    analysis: context,
    limits: { maxDependencyQueries: 2 },
  });

  assert.deepEqual(batchSizes, [2]);
  assert.equal(cvesByKey.size, 2);
  assert.equal(cvesByKey.has("npm:pkg-0:1.0.0"), true);
  assert.equal(cvesByKey.has("npm:pkg-1:1.0.0"), true);
  assert.equal(cvesByKey.has("npm:pkg-2:1.0.0"), false);
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, {
    "osv-direct-querybatch": 1,
  });
});

test("scanDependencyChanges falls back to direct OSV queries after an oversized batch response", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  let batchCalls = 0;
  const directPackages = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url) === "https://api.osv.dev/v1/querybatch") {
      batchCalls += 1;
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      });
    }

    assert.equal(String(url), "https://api.osv.dev/v1/query");
    const body = JSON.parse(String(init.body));
    directPackages.push(body.package.name);
    return jsonResponse({
      vulns:
        body.package.name === "left-pad"
          ? [
              {
                id: "GHSA-fallback",
                summary: "direct fallback advisory",
                database_specific: { severity: "HIGH" },
              },
            ]
          : [],
    });
  };
  const changes = [
    { ecosystem: "npm", package: "left-pad", from: null, to: "1.3.0" },
    { ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" },
    { ecosystem: "npm", package: "express", from: null, to: "4.18.0" },
  ];

  const findings = await scanDependencyChanges(changes, fetchImpl, {
    analysis: context,
    limits: { maxDependencyQueries: 25 },
  });

  assert.equal(batchCalls, 1);
  assert.deepEqual(directPackages, ["left-pad", "lodash", "express"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "left-pad");
  assert.equal(findings[0].cves[0].id, "GHSA-fallback");
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, {
    "osv-direct-querybatch": 1,
    "osv-query": 3,
  });
  assert.equal(context.snapshotMetrics().cacheMisses, 4);
  assert.equal(context.snapshotMetrics().cacheHits, 0);
});

test("createAnalysisContext leaves expensive diff surfaces lazy for skipped analyzers", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1817,
    files: [
      {
        path: "src/huge.ts",
        patch: ["@@ -1,0 +1,2 @@", "+const first = true;"].join("\n"),
      },
    ],
  });

  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {});
  assert.equal(context.changedFilePaths.length, 1);
  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {});
  assert.equal(context.hasAddedLines, true);
  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {});
});

test("createAnalysisContext caps materialized diff surfaces", () => {
  const oversizedPatch = [
    "@@ -1,0 +1,6000 @@",
    ...Array.from({ length: 6000 }, (_, index) => `+const value${index} = ${index};`),
  ].join("\n");
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1817,
    files: [
      {
        path: "src/huge.ts",
        patch: oversizedPatch,
      },
    ],
  });

  assert.equal(context.addedLines.length, 5000);
  assert.equal(context.addedLines.at(-1).line, 5000);
  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {
    added_lines: 1,
  });
});

test("createAnalysisContext keeps uncapped context-only patches as no added lines", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1817,
    files: [
      {
        path: "src/context-only.ts",
        patch: "@@ -1,1 +1,1 @@\n const value = true;",
      },
    ],
  });

  assert.equal(context.hasAddedLines, false);
  assert.deepEqual(context.snapshotMetrics().cappedWorkByCategory, {});
});

test("createAnalysisContext treats capped patch scans as added-line presence", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1817,
    files: [
      {
        path: "src/huge.ts",
        patch: `${" context\n".repeat(130000)}+const beyondCap = true;`,
      },
    ],
  });

  assert.equal(context.hasAddedLines, true);
  assert.equal(context.addedLines.length, 0);
  assert.equal(
    context.snapshotMetrics().cappedWorkByCategory.has_added_lines_patch_bytes > 0,
    true,
  );
  assert.equal(
    context.snapshotMetrics().cappedWorkByCategory.added_lines_patch_bytes > 0,
    true,
  );
});

test("createAnalysisContext classifies workflow paths case-insensitively", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 2516,
    files: [
      {
        path: ".github/Workflows/CI.YML",
        patch: "@@ -1,0 +1,1 @@\n+    - uses: pnpm/action-setup@v3",
      },
      {
        path: "docs/readme.md",
        patch: "@@ -1,0 +1,1 @@\n+# docs",
      },
    ],
  });

  assert.deepEqual(
    context.fileCategories.map((file) => [file.path, file.category]),
    [
      [".github/Workflows/CI.YML", "workflow"],
      ["docs/readme.md", "docs"],
    ],
  );
});

test("createAnalysisContext classifies Zstandard archives as assets for scheduler gating", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 3128,
    headSha: "abcdef1234567890",
    githubToken: "github_pat_test",
    analyzers: ["assetWeight"],
    files: [
      {
        path: "cache/model.zst",
        patch: null,
        status: "added",
      },
      {
        path: "dist/bundle.tar.ZST",
        patch: null,
        status: "added",
      },
    ],
  });

  assert.deepEqual(
    context.fileCategories.map((file) => [file.path, file.extension, file.category]),
    [
      ["cache/model.zst", ".zst", "asset"],
      ["dist/bundle.tar.ZST", ".zst", "asset"],
    ],
  );

  const plan = planAnalyzers(
    {
      repoFullName: "JSONbored/gittensory",
      prNumber: 3128,
      headSha: "abcdef1234567890",
      githubToken: "github_pat_test",
      analyzers: ["assetWeight"],
      files: context.changedFiles,
    },
    { assetWeight: async () => [] },
    context,
    { budgetMs: 5_000, startedAtMs: 0 },
  );

  assert.deepEqual(plan.runnable.map((item) => item.name), ["assetWeight"]);
  assert.deepEqual(plan.skipped.map((item) => [item.name, item.skipReason]), []);
});

test("createAnalysisContext classifies long-form doc extensions as docs", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 3264,
    files: [
      { path: "GUIDE.markdown", patch: "@@ -1,0 +1,1 @@\n+# guide" },
      { path: "docs/manual.adoc", patch: "@@ -1,0 +1,1 @@\n+= Manual" },
      { path: "docs/spec.asciidoc", patch: "@@ -1,0 +1,1 @@\n+= Spec" },
      { path: "README.ADOC", patch: "@@ -1,0 +1,1 @@\n+= Readme" },
      { path: "src/index.ts", patch: "@@ -1,0 +1,1 @@\n+export {};" },
    ],
  });

  assert.deepEqual(
    context.fileCategories.map((file) => [file.path, file.category]),
    [
      ["GUIDE.markdown", "docs"],
      ["docs/manual.adoc", "docs"],
      ["docs/spec.asciidoc", "docs"],
      ["README.ADOC", "docs"],
      ["src/index.ts", "source"],
    ],
  );
});

test("createAnalysisContext categorizes the full binary inventory as assets", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 3359,
    files: [
      // Binaries beyond the original narrow image/archive list — now recognized via the shared inventory.
      { path: "media/demo.mp4", patch: null, status: "added" },
      { path: "fonts/Inter.woff2", patch: null, status: "added" },
      { path: "vendor/lib.wasm", patch: null, status: "added" },
      { path: "models/llama.safetensors", patch: null, status: "added" },
      // .svg is text but still an asset for categorization (kept explicitly).
      { path: "icons/logo.svg", patch: "@@ -1,0 +1,1 @@\n+<svg/>" },
      // A real source file is unaffected.
      { path: "src/index.ts", patch: "@@ -1,0 +1,1 @@\n+export {};" },
    ],
  });

  assert.deepEqual(
    context.fileCategories.map((file) => [file.path, file.category]),
    [
      ["media/demo.mp4", "asset"],
      ["fonts/Inter.woff2", "asset"],
      ["vendor/lib.wasm", "asset"],
      ["models/llama.safetensors", "asset"],
      ["icons/logo.svg", "asset"],
      ["src/index.ts", "source"],
    ],
  );
});

test("createAnalysisContext classifies lockfile paths case-insensitively", () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 2611,
    files: [
      {
        path: "frontend/Package-Lock.JSON",
        patch: "@@ -1,0 +1,1 @@\n+{}",
      },
    ],
  });

  assert.deepEqual(context.fileCategories.map((file) => [file.path, file.category]), [
    ["frontend/Package-Lock.JSON", "lockfile"],
  ]);
});
