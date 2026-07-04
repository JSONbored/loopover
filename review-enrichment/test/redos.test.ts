// Units for the ReDoS analyzer's pure detectors (#2095). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractRegexSources,
  hasCatastrophicBacktracking,
  scanPatchForRedos,
} from "../dist/analyzers/redos.js";

test("extractRegexSources pulls bodies from /.../ literals and RegExp(...) args", () => {
  assert.deepEqual(extractRegexSources("const re = /(a+)+/.test(x);"), [
    "(a+)+",
  ]);
  assert.deepEqual(extractRegexSources('new RegExp("a|b")'), ["a|b"]);
  assert.deepEqual(extractRegexSources("plain text, no slashes"), []);
});

test("extractRegexSources finds a regex literal in an arrow body written without a space", () => {
  // `() =>/foo/` is valid JS; the `/` follows `>`, which must count as a regex-position boundary.
  assert.deepEqual(
    extractRegexSources("const match = (s) =>/(a+)+/.test(s);"),
    ["(a+)+"],
  );
  // Spaced form already worked via the whitespace branch; keep it locked.
  assert.deepEqual(
    extractRegexSources("const match = (s) => /(a+)+/.test(s);"),
    ["(a+)+"],
  );
});

test("hasCatastrophicBacktracking flags a nested unbounded quantifier and spares linear shapes", () => {
  for (const bad of ["(a+)+", "(\\d+)*", "(.*)+", "([a-z]+)+"]) {
    assert.equal(hasCatastrophicBacktracking(bad), true, bad);
  }
  for (const ok of ["(abc)+", "abc", "(a+)", "[a+]+", "(a|a)*"]) {
    assert.equal(hasCatastrophicBacktracking(ok), false, ok);
  }
});

test("scanPatchForRedos cites the added-line number of a catastrophic literal", () => {
  const patch = [
    "@@ -1,2 +1,3 @@",
    " context",
    "+const re = /(a+)+/;",
    " more",
  ].join("\n");
  const findings = scanPatchForRedos("src/x.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/x.ts");
  assert.equal(findings[0]?.line, 2);
  assert.equal(findings[0]?.kind, "nested-quantifier");
});

test("scanPatchForRedos does not let a no-newline marker skew the line number", () => {
  // `\ No newline at end of file` is not a new-file line; advancing past it would cite the
  // catastrophic literal one line too high (same class as the iac-misconfig regression).
  const patch = [
    "@@ -1,1 +1,2 @@",
    "-const x = 1;",
    "\\ No newline at end of file",
    "+const x = 1;",
    "+const re = /(a+)+/;",
  ].join("\n");
  const findings = scanPatchForRedos("src/x.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 2);
});

test("scanPatchForRedos ignores safe patterns and honours a zero finding budget", () => {
  const safe = ["@@ -1 +1,1 @@", "+const re = /(abc)+/;"].join("\n");
  assert.deepEqual(scanPatchForRedos("src/x.ts", safe), []);

  const bad = ["@@ -1 +1,1 @@", "+const re = /(a+)+/;"].join("\n");
  assert.deepEqual(scanPatchForRedos("src/x.ts", bad, { maxFindings: 0 }), []);
});
