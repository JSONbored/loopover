// Units for the leftover conflict-marker analyzer (#2032). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. No network — pure, structural per-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conflictMarkerOf,
  scanPatchForConflictMarkers,
  scanConflictMarkers,
} from "../dist/analyzers/conflict-marker.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("conflictMarkerOf: recognizes each of the four marker shapes (with and without a label)", () => {
  assert.equal(conflictMarkerOf("<<<<<<< HEAD", true), "<<<<<<<");
  assert.equal(conflictMarkerOf("<<<<<<<", true), "<<<<<<<");
  assert.equal(conflictMarkerOf("||||||| merged common ancestors", true), "|||||||");
  assert.equal(conflictMarkerOf("=======", true), "=======");
  assert.equal(conflictMarkerOf(">>>>>>> feature-branch", true), ">>>>>>>");
});

test("conflictMarkerOf: a run that is not exactly seven characters is not a marker", () => {
  assert.equal(conflictMarkerOf("<<<<<< HEAD", true), null); // six
  assert.equal(conflictMarkerOf("<<<<<<<< HEAD", true), null); // eight
  assert.equal(conflictMarkerOf("======", true), null); // six
  assert.equal(conflictMarkerOf("========", true), null); // eight
  assert.equal(conflictMarkerOf("  <<<<<<< HEAD", true), null); // not at column 0
});

test("conflictMarkerOf: a `=======` separator with a trailing label is not a bare separator", () => {
  // The separator is a BARE seven `=`; anything after it (unlike ours/theirs which allow a label) is not a marker.
  assert.equal(conflictMarkerOf("======= not a marker", true), null);
});

test("conflictMarkerOf: the `=======` separator is suppressed in markup (allowSeparator=false) but ours/theirs are not", () => {
  assert.equal(conflictMarkerOf("=======", false), null); // setext-H1 underline / AsciiDoc rule
  assert.equal(conflictMarkerOf("<<<<<<< HEAD", false), "<<<<<<<"); // a real conflict still caught in markup
  assert.equal(conflictMarkerOf(">>>>>>> theirs", false), ">>>>>>>");
});

test("scanPatchForConflictMarkers: flags a full three-way conflict on added lines with correct locations", () => {
  const findings = scanPatchForConflictMarkers(
    "src/app.ts",
    patchOf(["<<<<<<< HEAD", "const x = 1;", "=======", "const x = 2;", ">>>>>>> other"]),
  );
  assert.deepEqual(findings, [
    { file: "src/app.ts", line: 1, marker: "<<<<<<<" },
    { file: "src/app.ts", line: 3, marker: "=======" },
    { file: "src/app.ts", line: 5, marker: ">>>>>>>" },
  ]);
});

test("scanPatchForConflictMarkers: a markdown setext-H1 underline (=======) is not flagged", () => {
  const findings = scanPatchForConflictMarkers(
    "docs/guide.md",
    patchOf(["My Heading", "=======", "Some prose."]),
  );
  assert.deepEqual(findings, []);
});

test("scanPatchForConflictMarkers: a real conflict landing in a markdown file is still caught by ours/theirs", () => {
  const findings = scanPatchForConflictMarkers(
    "docs/guide.md",
    patchOf(["<<<<<<< HEAD", "old text", "=======", "new text", ">>>>>>> branch"]),
  );
  // The `=======` is suppressed in markup, but the ours/theirs markers still fire.
  assert.deepEqual(findings, [
    { file: "docs/guide.md", line: 1, marker: "<<<<<<<" },
    { file: "docs/guide.md", line: 5, marker: ">>>>>>>" },
  ]);
});

test("scanPatchForConflictMarkers: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {", // context line 10
    "-=======", // removed, does not advance
    "+>>>>>>> feature", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForConflictMarkers("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, marker: ">>>>>>>" },
  ]);
});

test("scanPatchForConflictMarkers: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, () => "<<<<<<< HEAD");
  assert.equal(scanPatchForConflictMarkers("src/a.ts", patchOf(lines), 5).length, 5);
  assert.deepEqual(scanPatchForConflictMarkers("src/a.ts", patchOf(lines), 0), []);
});

test("scanConflictMarkers: scans every changed file and honors the global cap", async () => {
  const markers = Array.from({ length: 30 }, () => ">>>>>>> b");
  const findings = await scanConflictMarkers({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/a.ts", patch: patchOf(["const ok = true;"]) },
      { path: "src/b.ts", patch: patchOf(markers) },
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/b.ts"));
});

test("scanConflictMarkers: no files yields no findings", async () => {
  assert.deepEqual(await scanConflictMarkers({ repoFullName: "octo/repo", prNumber: 1 }), []);
});
