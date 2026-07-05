// Units for the flaky-test history annotator (#2033). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isTestCheckName,
  referencesTestFile,
  countCommitTestFailures,
  scanFlakyTest,
} from "../dist/analyzers/flaky-test.js";
import { renderBrief } from "../dist/render.js";

const jsonResponse = (body, code = 200) =>
  new Response(JSON.stringify(body), { status: code });

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  files,
  ...extra,
});

test("isTestCheckName: matches common test job names", () => {
  assert.equal(isTestCheckName("validate-code"), true);
  assert.equal(isTestCheckName("jest / unit"), true);
  assert.equal(isTestCheckName("build"), false);
});

test("referencesTestFile: matches full path, basename, or stem in structured output", () => {
  assert.equal(
    referencesTestFile({ summary: "FAIL src/foo/bar.test.ts" }, "src/foo/bar.test.ts"),
    true,
  );
  assert.equal(referencesTestFile({ title: "bar.test.ts failed" }, "src/foo/bar.test.ts"), true);
  assert.equal(referencesTestFile({ summary: "unrelated failure" }, "src/foo/bar.test.ts"), false);
});

test("countCommitTestFailures: counts only failed test checks referencing the file", () => {
  const runs = [
    {
      name: "validate-code",
      status: "completed",
      conclusion: "failure",
      output: { summary: "FAIL src/app.test.ts" },
    },
    {
      name: "build",
      status: "completed",
      conclusion: "failure",
      output: { summary: "src/app.test.ts compile error" },
    },
    {
      name: "jest",
      status: "completed",
      conclusion: "success",
      output: { summary: "src/app.test.ts" },
    },
  ];
  assert.equal(countCommitTestFailures(runs, "src/app.test.ts"), 1);
});

test("scanFlakyTest: flags a changed test file with repeated recent CI failures", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/repos/octo/repo") && !url.includes("/commits")) {
      return jsonResponse({ default_branch: "main" });
    }
    if (url.includes("path=src%2Fapp.test.ts") && !url.includes("/check-runs")) {
      return jsonResponse([{ sha: "aaa" }, { sha: "bbb" }, { sha: "ccc" }]);
    }
    if (url.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          {
            name: "validate-code",
            status: "completed",
            conclusion: "failure",
            output: { summary: "FAIL src/app.test.ts" },
          },
        ],
      });
    }
    return new Response("", { status: 404 });
  };
  const findings = await scanFlakyTest(
    req([{ path: "src/app.test.ts", status: "modified" }]),
    fetchFn,
  );
  assert.deepEqual(findings, [{ file: "src/app.test.ts", recentFailures: 3, window: "30d" }]);
  const brief = renderBrief({ flakyTest: findings }).promptSection;
  assert.match(brief, /Flaky-test history/i);
});

test("scanFlakyTest: does not flag when recent test checks are clean", async () => {
  const fetchFn = async (url) => {
    if (url.includes("/repos/octo/repo") && !url.includes("/commits")) {
      return jsonResponse({ default_branch: "main" });
    }
    if (url.includes("path=src%2Fclean.test.ts")) {
      return jsonResponse([{ sha: "aaa" }, { sha: "bbb" }]);
    }
    if (url.includes("/check-runs")) {
      return jsonResponse({
        check_runs: [
          {
            name: "validate-code",
            status: "completed",
            conclusion: "success",
            output: { summary: "ok src/clean.test.ts" },
          },
        ],
      });
    }
    return new Response("", { status: 404 });
  };
  const findings = await scanFlakyTest(
    req([{ path: "src/clean.test.ts", status: "modified" }]),
    fetchFn,
  );
  assert.deepEqual(findings, []);
});

test("scanFlakyTest: marks partial status when the check-run probe cap is hit", async () => {
  const files = Array.from({ length: 8 }, (_, i) => ({
    path: `src/t${i}.test.ts`,
    status: "modified",
  }));
  let checkRunCalls = 0;
  const diagnostics = {};
  const fetchFn = async (url) => {
    if (url.includes("/repos/octo/repo") && !url.includes("/commits")) {
      return jsonResponse({ default_branch: "main" });
    }
    if (url.includes("/commits?") && url.includes("path=")) {
      return jsonResponse([{ sha: "aaa" }, { sha: "bbb" }, { sha: "ccc" }]);
    }
    if (url.includes("/check-runs")) {
      checkRunCalls += 1;
      return jsonResponse({
        check_runs: [
          {
            name: "validate-code",
            status: "completed",
            conclusion: "failure",
            output: { summary: "FAIL src/t0.test.ts" },
          },
        ],
      });
    }
    return new Response("", { status: 404 });
  };
  await scanFlakyTest(req(files), fetchFn, { diagnostics });
  assert.equal(checkRunCalls, 12);
  assert.equal(diagnostics.partialStatus, "partial");
  assert.equal(diagnostics.partialReason, "flaky_test_probe_cap");
});

test("scanFlakyTest: returns no findings without a GitHub token", async () => {
  const findings = await scanFlakyTest(
    req([{ path: "src/app.test.ts", status: "modified" }], { githubToken: undefined }),
    async () => jsonResponse({}),
  );
  assert.deepEqual(findings, []);
});
