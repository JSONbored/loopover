// Units for the test-to-code ratio analyzer (#2024). No network involved — pure compute over req.files. Runs
// against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateTestRatio,
  isTestPath,
  scanTestRatio,
} from "../dist/analyzers/test-ratio.js";

test("evaluateTestRatio: flags a source-heavy PR with little/no accompanying test change", () => {
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 100 },
    { path: "src/widget.test.ts", additions: 5 },
  ]);
  assert.deepEqual(findings, [
    { sourceAdded: 100, testAdded: 5, sourceFiles: 1, testFiles: 1, ratio: 0.05, belowThreshold: true },
  ]);
});

test("evaluateTestRatio: a well-tested PR (ratio at/above threshold) is not flagged", () => {
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 100 },
    { path: "src/widget.test.ts", additions: 40 },
  ]);
  assert.deepEqual(findings, []);
});

test("evaluateTestRatio: a docs-only PR is not flagged (no recognized source extension)", () => {
  const findings = evaluateTestRatio([
    { path: "README.md", additions: 500 },
    { path: "docs/guide.md", additions: 200 },
  ]);
  assert.deepEqual(findings, []);
});

test("evaluateTestRatio: an immaterial source change is not flagged even with zero tests (below the material floor)", () => {
  const findings = evaluateTestRatio([{ path: "src/widget.ts", additions: 10 }]);
  assert.deepEqual(findings, []);
});

test("evaluateTestRatio: a source change exactly at the material floor with zero tests IS flagged", () => {
  const findings = evaluateTestRatio([{ path: "src/widget.ts", additions: 20 }]);
  assert.deepEqual(findings, [
    { sourceAdded: 20, testAdded: 0, sourceFiles: 1, testFiles: 0, ratio: 0, belowThreshold: true },
  ]);
});

test("evaluateTestRatio: a ratio exactly at the threshold is NOT flagged (>= threshold is fine)", () => {
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 100 },
    { path: "src/widget.test.ts", additions: 30 },
  ]);
  assert.deepEqual(findings, []); // 30/100 = 0.3, the exact threshold
});

test("evaluateTestRatio: a ratio just under the threshold IS flagged", () => {
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 100 },
    { path: "src/widget.test.ts", additions: 29 },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].belowThreshold, true);
});

test("evaluateTestRatio: sums additions and counts files across multiple source and test files", () => {
  const findings = evaluateTestRatio([
    { path: "src/a.ts", additions: 50 },
    { path: "src/b.ts", additions: 50 },
    { path: "test/a.test.ts", additions: 3 },
  ]);
  assert.deepEqual(findings, [
    { sourceAdded: 100, testAdded: 3, sourceFiles: 2, testFiles: 1, ratio: 0.03, belowThreshold: true },
  ]);
});

test("evaluateTestRatio: a file with no additions field is treated as zero", () => {
  const findings = evaluateTestRatio([{ path: "src/widget.ts" }, { path: "src/widget.ts", additions: 25 }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceAdded, 25);
});

test("evaluateTestRatio: an empty file list yields no finding", () => {
  assert.deepEqual(evaluateTestRatio([]), []);
});

test("evaluateTestRatio: a non-source fixture/snapshot under a test/ directory does not count as test coverage", () => {
  // Regression test: a JSON fixture living under tests/ must not inflate testAdded and mask a real source-only
  // change from being flagged — it is data, not test CODE.
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 20 },
    { path: "tests/fixtures/snapshot.json", additions: 6 },
  ]);
  assert.deepEqual(findings, [
    { sourceAdded: 20, testAdded: 0, sourceFiles: 1, testFiles: 0, ratio: 0, belowThreshold: true },
  ]);
});

test("evaluateTestRatio: a non-source file outside any test directory is not counted as source either", () => {
  const findings = evaluateTestRatio([
    { path: "src/widget.ts", additions: 20 },
    { path: "config/settings.json", additions: 100 },
  ]);
  assert.deepEqual(findings, [
    { sourceAdded: 20, testAdded: 0, sourceFiles: 1, testFiles: 0, ratio: 0, belowThreshold: true },
  ]);
});

test("isTestPath: recognizes the test/tests/spec/__tests__ directory convention", () => {
  assert.equal(isTestPath("test/widget.ts"), true);
  assert.equal(isTestPath("tests/widget.py"), true);
  assert.equal(isTestPath("spec/widget.rb"), true);
  assert.equal(isTestPath("src/__tests__/widget.js"), true);
});

test("isTestPath: recognizes the .test./.spec. suffix convention", () => {
  assert.equal(isTestPath("src/widget.test.ts"), true);
  assert.equal(isTestPath("src/widget.spec.js"), true);
  assert.equal(isTestPath("src/widget.ts"), false);
});

test("isTestPath: recognizes pytest's test_*.py prefix and the Go/Python/Ruby/Dart *_test.EXT suffix convention", () => {
  assert.equal(isTestPath("pkg/test_widget.py"), true);
  assert.equal(isTestPath("pkg/widget_test.go"), true);
  // Regression: a prior version's suffix regex only covered *_test.go (and *_spec.rb, mis-merged into the same
  // alternation), silently dropping *_test.py/*_test.rb/*_test.dart — the exact gap a real PR could hit
  // (adding pkg/foo.py + pkg/foo_test.py and having both files miscounted as source).
  assert.equal(isTestPath("pkg/foo_test.py"), true);
  assert.equal(isTestPath("pkg/foo_test.rb"), true);
  assert.equal(isTestPath("lib/foo_test.dart"), true);
  assert.equal(isTestPath("pkg/widget_spec.rb"), true);
});

test("isTestPath: recognizes the JVM/C#/Swift/PHP PascalCase Test(s)/Spec class-suffix convention", () => {
  assert.equal(isTestPath("src/WidgetTest.java"), true);
  assert.equal(isTestPath("src/WidgetTests.cs"), true);
  assert.equal(isTestPath("src/WidgetSpec.kt"), true);
  assert.equal(isTestPath("src/WidgetTests.swift"), true);
  assert.equal(isTestPath("src/WidgetSpec.groovy"), true);
  assert.equal(isTestPath("src/WidgetTest.php"), true);
  assert.equal(isTestPath("src/Latest.java"), false); // must not false-positive on words merely ending in "test"
});

test("isTestPath: recognizes the src/test/ directory and __snapshots__/ directory conventions", () => {
  assert.equal(isTestPath("src/test/Foo.kt"), true);
  assert.equal(isTestPath("src/__snapshots__/widget.snap"), true);
});

test("isTestPath: recognizes the Cypress/Playwright .cy./.e2e. suffix convention", () => {
  assert.equal(isTestPath("src/widget.cy.ts"), true);
  assert.equal(isTestPath("src/widget.e2e.js"), true);
});

test("isTestPath: recognizes the .test./.spec. suffix on the additional TS/JS module extensions", () => {
  assert.equal(isTestPath("src/widget.test.mts"), true);
  assert.equal(isTestPath("src/widget.spec.cts"), true);
});

test("isTestPath: an ordinary source file is not a test path", () => {
  assert.equal(isTestPath("src/analyzers/widget.ts"), false);
});

test("evaluateTestRatio: end-to-end regression for the exact blocker scenario (pkg/foo.py + pkg/foo_test.py)", () => {
  const findings = evaluateTestRatio([
    { path: "pkg/foo.py", additions: 25 },
    { path: "pkg/foo_test.py", additions: 25 },
  ]);
  // Correctly classified as source + test in a healthy ratio -> not flagged (previously both miscounted as
  // source, which would ALSO not flag — but for the wrong reason, and would misreport testAdded as 0 in the
  // rendered brief if the ratio ever did dip below threshold on a bigger PR).
  assert.deepEqual(findings, []);
});

test("scanTestRatio: end-to-end wraps evaluateTestRatio with no network involved", async () => {
  const findings = await scanTestRatio({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/widget.ts", additions: 100 },
      { path: "src/widget.test.ts", additions: 5 },
    ],
  });
  assert.deepEqual(findings, [
    { sourceAdded: 100, testAdded: 5, sourceFiles: 1, testFiles: 1, ratio: 0.05, belowThreshold: true },
  ]);
});

test("scanTestRatio: no files yields no finding", async () => {
  const findings = await scanTestRatio({ repoFullName: "octo/repo", prNumber: 1 });
  assert.deepEqual(findings, []);
});
