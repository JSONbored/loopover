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

test("scanPatchForLooseRanges: flags each loose kind inside a visible dependencies block with correct locations", () => {
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"dependencies": {',
      '"left-pad": "*",',
      '"lodash": "latest",',
      '"react": ">=18.0.0",',
      '"express": "4",',
    ]),
  );
  assert.deepEqual(findings, [
    { file: "package.json", line: 2, package: "left-pad", range: "*", kind: "wildcard" },
    { file: "package.json", line: 3, package: "lodash", range: "latest", kind: "latest" },
    { file: "package.json", line: 4, package: "react", range: ">=18.0.0", kind: "unbounded-gte" },
    { file: "package.json", line: 5, package: "express", range: "4", kind: "bare" },
  ]);
});

test("scanPatchForLooseRanges: pinned/caret/tilde specifiers and non-range values are not flagged", () => {
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"dependencies": {',
      '"left-pad": "1.3.0",',
      '"lodash": "^4.17.21",',
      '"react": "~18.2.0",',
      "},",
      '"main": "index.js",',
      '"license": "MIT",',
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForLooseRanges: a dependency literally named npm/node/vscode is still flagged inside a dependency block", () => {
  // Regression for the section-aware suppression: `npm`, `node`, and `vscode` are real, installable registry
  // packages. When the enclosing `"dependencies"` block is visible, its entries are ALL dependencies — the
  // engines/publishConfig key-name fallback must not suppress them.
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf(['"dependencies": {', '"npm": "*",', '"node": ">=18",', '"vscode": "latest",', "},"]),
  );
  assert.deepEqual(findings, [
    { file: "package.json", line: 2, package: "npm", range: "*", kind: "wildcard" },
    { file: "package.json", line: 3, package: "node", range: ">=18", kind: "unbounded-gte" },
    { file: "package.json", line: 4, package: "vscode", range: "latest", kind: "latest" },
  ]);
});

test("scanPatchForLooseRanges: entries inside a visible engines/publishConfig block are never dependencies", () => {
  // `"node": ">=18"` inside engines is legitimate and extremely common; a publishConfig dist-tag is not a
  // dependency either. With the section visible, EVERY entry in a non-dependency block is skipped.
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"engines": {',
      '"node": ">=18.0.0",',
      '"some-engine": "*",',
      "},",
      '"publishConfig": {',
      '"tag": "latest",',
      "},",
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForLooseRanges: a hunk with no visible section header stays silent — positive dependency context is required", () => {
  // Regression for the fail-closed rule: a hunk that starts mid-`engines`/`scripts`/tool-config has no
  // section context, so NOTHING is judged — `"some-engine": "*"` or `"releaseTag": "latest"` in such a hunk
  // must not be reported as a loose dependency, and even a real-looking dependency line stays silent rather
  // than guessed at.
  const findings = scanPatchForLooseRanges(
    "package.json",
    patchOf([
      '"some-engine": "*",',
      '"releaseTag": "latest",',
      '"node": ">=18.0.0",',
      '"left-pad": "*",',
    ]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForLooseRanges: section state resets at each hunk boundary and is tracked from context lines too", () => {
  const patch = [
    "@@ -5,3 +5,3 @@",
    ' "dependencies": {', // context line establishes the section for this hunk
    '+"left-pad": "*",', // new-file line 6 — flagged (inside dependencies)
    " },",
    "@@ -20,2 +20,2 @@",
    // New hunk: the dependencies state above must NOT leak here. No header visible → silent, even for
    // lines that would classify as loose inside a dependency block.
    '+"node": ">=18",',
    '+"some-lib": "latest",',
  ].join("\n");
  const findings = scanPatchForLooseRanges("package.json", patch);
  assert.deepEqual(findings, [
    { file: "package.json", line: 6, package: "left-pad", range: "*", kind: "wildcard" },
  ]);
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
  const lines = ['"dependencies": {', ...Array.from({ length: 30 }, (_, i) => `"pkg-${i}": "*",`)];
  const findings = scanPatchForLooseRanges("package.json", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(findings.map((f) => f.line), [2, 3, 4, 5, 6]);

  assert.deepEqual(
    scanPatchForLooseRanges("package.json", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanLooseRanges: scans only package.json files and honors the global cap across files", async () => {
  const looseLines = ['"dependencies": {', ...Array.from({ length: 15 }, (_, i) => `"pkg-${i}": "latest",`)];
  const findings = await scanLooseRanges({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "config/settings.json", patch: patchOf(['"dependencies": {', '"left-pad": "*",']) },
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
