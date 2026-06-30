// Units for the shared REES analysis context (#1810). Kept separate so future analyzer PRs can add their own
// migrations without fighting over the broad enrichment test file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnalysisContext } from "../dist/analysis-context.js";
import { scanDependencyChanges } from "../dist/analyzers/dependency-scan.js";

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
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

test("scanDependencyChanges reuses cached OSV package lookups inside one request", async () => {
  const context = createAnalysisContext({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1810,
  });
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return jsonResponse({
      vulns: [
        {
          id: "GHSA-test",
          summary: "test advisory",
          database_specific: { severity: "HIGH" },
        },
      ],
    });
  };
  const duplicateChanges = [
    { ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" },
    { ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" },
  ];

  const findings = await scanDependencyChanges(duplicateChanges, fetchImpl, {
    cache: context,
    limits: { maxDependencyQueries: 25 },
  });

  assert.equal(fetchCalls, 1);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].cves[0].id, "GHSA-test");
  assert.deepEqual(context.snapshotMetrics().externalCallsByCategory, { osv: 1 });
  assert.equal(context.snapshotMetrics().cacheMisses, 1);
  assert.equal(context.snapshotMetrics().cacheHits, 1);
});
