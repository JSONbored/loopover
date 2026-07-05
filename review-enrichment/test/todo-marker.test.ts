// Units for the TODO/FIXME/HACK/XXX marker analyzer (#2016). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. No network — pure, stateless per-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTodoMarker,
  scanPatchForTodoMarker,
  scanTodoMarker,
} from "../dist/analyzers/todo-marker.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectTodoMarker: recognizes each tag with its note across comment styles", () => {
  assert.deepEqual(detectTodoMarker("  // TODO: wire up retries"), { tag: "TODO", note: "wire up retries" });
  assert.deepEqual(detectTodoMarker("    # FIXME handle nulls"), { tag: "FIXME", note: "handle nulls" });
  assert.deepEqual(detectTodoMarker("x(); /* HACK: temporary */"), { tag: "HACK", note: "temporary" });
  assert.deepEqual(detectTodoMarker("   * XXX revisit this"), { tag: "XXX", note: "revisit this" });
  assert.deepEqual(detectTodoMarker("<!-- TODO update docs -->"), { tag: "TODO", note: "update docs" });
});

test("detectTodoMarker: a bare marker with no note has no note field", () => {
  assert.deepEqual(detectTodoMarker("// TODO"), { tag: "TODO" });
  assert.deepEqual(detectTodoMarker("  // FIXME  "), { tag: "FIXME" });
});

test("detectTodoMarker: only UPPERCASE tags match — a lowercase identifier is not a marker", () => {
  assert.equal(detectTodoMarker("const todoList = []"), null);
  assert.equal(detectTodoMarker("// fixme later"), null); // lowercase in a comment is not the marker convention
  assert.equal(detectTodoMarker("this.#todo = 1"), null);
});

test("detectTodoMarker: must be comment-anchored — an uppercase tag in code is not flagged", () => {
  assert.equal(detectTodoMarker("const TODO = getPending()"), null);
  assert.equal(detectTodoMarker("return base * TODO"), null); // a `*` mid-expression is not a JSDoc lead
  assert.equal(detectTodoMarker("arr.push(TODO)"), null);
});

test("detectTodoMarker: a marker inside a string literal is not flagged", () => {
  assert.equal(detectTodoMarker('const s = "// TODO: not real"'), null);
  assert.equal(detectTodoMarker("log(`hint: // FIXME here`)"), null);
});

test("detectTodoMarker: TODOS / XXXL are not markers (word boundary after the tag)", () => {
  assert.equal(detectTodoMarker("// TODOS: plural list"), null);
  assert.equal(detectTodoMarker("// XXXL size chart"), null);
});

test("detectTodoMarker: a trailing block-comment/HTML close is stripped from the note", () => {
  assert.deepEqual(detectTodoMarker("/* TODO: fix the leak */"), { tag: "TODO", note: "fix the leak" });
  assert.deepEqual(detectTodoMarker("<!-- FIXME: broken link -->"), { tag: "FIXME", note: "broken link" });
});

test("detectTodoMarker: an overlong note is truncated to the cap", () => {
  const long = "x".repeat(300);
  const hit = detectTodoMarker(`// TODO: ${long}`);
  assert.equal(hit.tag, "TODO");
  assert.equal(hit.note.length, 120);
});

test("scanPatchForTodoMarker: flags markers on added lines with correct locations", () => {
  const findings = scanPatchForTodoMarker(
    "src/net.ts",
    patchOf(["function f() {", "  // TODO: retries", "  return g();", "  // HACK sleep to avoid a race", "}"]),
  );
  assert.deepEqual(findings, [
    { file: "src/net.ts", line: 2, tag: "TODO", note: "retries" },
    { file: "src/net.ts", line: 4, tag: "HACK", note: "sleep to avoid a race" },
  ]);
});

test("scanPatchForTodoMarker: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {", // context line 10
    "-  // TODO: old note", // removed, does not advance
    "+  // TODO: new note", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForTodoMarker("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, tag: "TODO", note: "new note" },
  ]);
});

test("scanPatchForTodoMarker: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `// TODO: item ${i}`);
  const findings = scanPatchForTodoMarker("src/a.ts", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(
    scanPatchForTodoMarker("src/a.ts", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanTodoMarker: scans every changed file and honors the global cap", async () => {
  const todoLines = Array.from({ length: 30 }, (_, i) => `// TODO: ${i}`);
  const findings = await scanTodoMarker({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/a.ts", patch: patchOf(["const x = 1;"]) },
      { path: "src/b.ts", patch: patchOf(todoLines) },
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/b.ts"));
});

test("scanTodoMarker: no files yields no findings", async () => {
  assert.deepEqual(await scanTodoMarker({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: todo-marker findings render tag, location, and note", () => {
  const { promptSection } = renderBrief({
    todoMarker: [
      { file: "src/net.ts", line: 2, tag: "TODO", note: "wire up retries" },
      { file: "src/net.ts", line: 9, tag: "HACK" },
    ],
  });
  assert.match(promptSection, /Incomplete-work markers/);
  assert.match(promptSection, /src\/net\.ts:2/);
  assert.match(promptSection, /TODO/);
  assert.match(promptSection, /wire up retries/);
});
