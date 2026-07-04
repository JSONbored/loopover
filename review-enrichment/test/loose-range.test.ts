// Units for the loose dependency version-range analyzer (#2036). Own file (not enrichment.test.ts) so
// concurrent analyzer PRs don't collide. No network involved — pure compute over added package.json patch
// lines. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRange,
  scanPatchForLooseRanges,
  scanLooseRanges,
} from "../dist/analyzers/loose-range.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("classifyRange: classifies each loose kind", () => {
  assert.equal(classifyRange("*"), "wildcard");
  assert.equal(classifyRange("x"), "wildcard");
  assert.equal(classifyRange("X"), "wildcard");
  assert.equal(classifyRange("latest"), "latest");
  assert.equal(classifyRange(">=1.2.3"), "unbounded-gte");
  assert.equal(classifyRange(">2.0.0"), "unbounded-gte");
  assert.equal(classifyRange("18"), "bare");
  assert.equal(classifyRange("18.x"), "bare");
  assert.equal(classifyRange("18.x.x"), "bare");
});

test("classifyRange: pinned, caret, tilde, and bounded ranges are not loose", () => {
  assert.equal(classifyRange("1.2.3"), null);
  assert.equal(classifyRange("^1.2.3"), null);
  assert.equal(classifyRange("~1.2.3"), null);
  assert.equal(classifyRange(">=1.2.3 <2.0.0"), null); // upper bound present — bounded
  assert.equal(classifyRange("18.2"), null); // minor given — not a bare major
  assert.equal(classifyRange("beta"), null); // non-latest dist-tag is out of scope
  assert.equal(classifyRange("workspace:*"), null); // workspace protocol, not an npm range
});

test("classifyRange: unwraps an npm: alias and classifies the aliased range", () => {
  assert.equal(classifyRange("npm:left-pad@*"), "wildcard");
  assert.equal(classifyRange("npm:@scope/pkg@latest"), "latest");
  assert.equal(classifyRange("npm:left-pad@^1.3.0"), null);
});

test("scanPatchForLooseRanges: flags each loose kind on added dependency lines with correct locations", () => {
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"left-pad": "*",',
      '"lodash": "latest",',
      '"react": ">=18.0.0",',
      '"express": "4",',
    ]),
  );
  assert.deepEqual(findings, [
    { file: "package.json", line: 1, package: "left-pad", range: "*", kind: "wildcard" },
    { file: "package.json", line: 2, package: "lodash", range: "latest", kind: "latest" },
    { file: "package.json", line: 3, package: "react", range: ">=18.0.0", kind: "unbounded-gte" },
    { file: "package.json", line: 4, package: "express", range: "4", kind: "bare" },
  ]);
});

test("scanPatchForLooseRanges: pinned/caret/tilde specifiers and non-range values are not flagged", () => {
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"left-pad": "1.3.0",',
      '"lodash": "^4.17.21",',
      '"react": "~18.2.0",',
      '"main": "index.js",',
      '"license": "MIT",',
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForLooseRanges: well-known engines/publishConfig keys are not dependency specifiers", () => {
  // `"node": ">=18"` inside engines is legitimate and extremely common — the deny-list keeps the analyzer
  // from flagging it even though the value alone classifies as unbounded-gte.
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf(['"node": ">=18.0.0",', '"npm": ">=9",', '"tag": "latest",', '"version": "1",']),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForLooseRanges: only ADDED lines are scanned — removed and context lines are ignored", () => {
  const patch = [
    "@@ -1,2 +1,2 @@",
    '-"left-pad": "*",',
    ' "lodash": "latest",',
    '+"react": "^18.2.0",',
  ].join("\n");
  assert.deepEqual(scanPatchForLooseRanges("package.json", patch), []);
});

test("scanPatchForLooseRanges: new-file line numbers stay correct across context and removed lines", () => {
  const patch = [
    "@@ -10,3 +10,3 @@",
    ' "dependencies": {', // new-file line 10
    '-"left-pad": "^1.3.0",', // removed, does not advance
    '+"left-pad": "*",', // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForLooseRanges("package.json", patch), [
    { file: "package.json", line: 11, package: "left-pad", range: "*", kind: "wildcard" },
  ]);
});

test("scanPatchForLooseRanges: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `"pkg-${i}": "*",`);
  const findings = scanPatchForLooseRanges("package.json", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3, 4, 5]);

  assert.deepEqual(
    scanPatchForLooseRanges("package.json", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanLooseRanges: scans only package.json files and honors the global cap across files", async () => {
  const looseLines = Array.from({ length: 15 }, (_, i) => `"pkg-${i}": "latest",`);
  const findings = await scanLooseRanges({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "config/settings.json", patch: patchOf(['"left-pad": "*",']) },
      { path: "package.json", patch: patchOf(looseLines) },
      { path: "apps/web/package.json", patch: patchOf(looseLines) },
    ],
  });
  assert.equal(findings.length, 20); // 15 from the root manifest + capped 5 from the workspace one
  assert.equal(findings.filter((f) => f.file === "apps/web/package.json").length, 5);
});

test("scanLooseRanges: no files yields no findings", async () => {
  assert.deepEqual(await scanLooseRanges({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: loose-range findings render package, specifier, location, and a public-safe explanation", () => {
  const { promptSection } = renderBrief({
    looseRange: [
      { file: "package.json", line: 12, package: "left-pad", range: "*", kind: "wildcard" },
      { file: "package.json", line: 13, package: "lodash", range: "latest", kind: "latest" },
    ],
  });
  assert.match(promptSection, /Loose dependency version ranges/);
  assert.match(promptSection, /left-pad@"\*"/);
  assert.match(promptSection, /package\.json:12/);
  assert.match(promptSection, /not reproducible/);
});
