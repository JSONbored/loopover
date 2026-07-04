// Units for the leftover debug-statement analyzer (#2015). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. No network — pure compute over added patch lines. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDebugLeftover,
  scanPatchForDebugLeftover,
  scanDebugLeftover,
} from "../dist/analyzers/debug-leftover.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectDebugLeftover: flags a debugger statement and bare console.log/console.debug in JS/TS", () => {
  assert.equal(detectDebugLeftover("  debugger;", "js"), "debugger");
  assert.equal(detectDebugLeftover("  console.log(x);", "js"), "console");
  assert.equal(detectDebugLeftover("  console.debug(x);", "js"), "console");
  assert.equal(detectDebugLeftover("  console . log ( x );", "js"), "console");
});

test("detectDebugLeftover: intentional console methods and property-access lookalikes are not flagged", () => {
  assert.equal(detectDebugLeftover("  console.error(err);", "js"), null);
  assert.equal(detectDebugLeftover("  console.warn(msg);", "js"), null);
  assert.equal(detectDebugLeftover("  console.info(msg);", "js"), null);
  assert.equal(detectDebugLeftover("  logger.console.log(x);", "js"), null); // a property named console
  assert.equal(detectDebugLeftover("  this.debugger = true;", "js"), null); // property, not a statement
});

test("detectDebugLeftover: a console.log/debugger inside a string or comment is not flagged", () => {
  assert.equal(detectDebugLeftover('  throw new Error("do not use console.log");', "js"), null);
  assert.equal(detectDebugLeftover("  // console.log(x) left as a note", "js"), null);
  assert.equal(detectDebugLeftover("  foo(); /* console.log(x) */", "js"), null);
  assert.equal(detectDebugLeftover("   * console.log(x) in a JSDoc line", "js"), null);
  assert.equal(detectDebugLeftover("  const s = `use debugger; here`;", "js"), null);
});

test("detectDebugLeftover: flags a bare Python print() but not method/substring lookalikes", () => {
  assert.equal(detectDebugLeftover("    print('hello')", "py"), "print");
  assert.equal(detectDebugLeftover("    print(x, y)", "py"), "print");
  assert.equal(detectDebugLeftover("    self.print(x)", "py"), null); // a method named print
  assert.equal(detectDebugLeftover("    pprint(x)", "py"), null); // different function
  assert.equal(detectDebugLeftover("    blueprint(x)", "py"), null);
  assert.equal(detectDebugLeftover("    # print(x) commented out", "py"), null);
  assert.equal(detectDebugLeftover('    msg = "print(x)"', "py"), null); // inside a string
});

test("detectDebugLeftover: language gating — console/debugger only in JS, print only in Python", () => {
  assert.equal(detectDebugLeftover("  print(x)", "js"), null); // print is not a JS debug leftover
  assert.equal(detectDebugLeftover("  console.log(x);", "py"), null); // console.log is not Python
  assert.equal(detectDebugLeftover("  debugger;", "py"), null);
});

test("scanPatchForDebugLeftover: flags each kind on added lines with correct locations", () => {
  const findings = scanPatchForDebugLeftover(
    "src/widget.ts",
    patchOf(["export function f() {", "  debugger;", "  console.log(value);", "  return value;", "}"]),
  );
  assert.deepEqual(findings, [
    { file: "src/widget.ts", line: 2, kind: "debugger" },
    { file: "src/widget.ts", line: 3, kind: "console" },
  ]);
});

test("scanPatchForDebugLeftover: a non-JS/Python file is not scanned", () => {
  assert.deepEqual(
    scanPatchForDebugLeftover("config/notes.md", patchOf(["console.log(x); and print(y)"])),
    [],
  );
});

test("scanPatchForDebugLeftover: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {", // context line 10
    "-  console.log(old);", // removed, does not advance
    "+  console.log(fresh);", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForDebugLeftover("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, kind: "console" },
  ]);
});

test("scanPatchForDebugLeftover: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, () => "console.log(x);");
  const findings = scanPatchForDebugLeftover("src/a.ts", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(
    scanPatchForDebugLeftover("src/a.ts", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanDebugLeftover: skips test/spec files and honors the global cap across files", async () => {
  const consoleLines = Array.from({ length: 30 }, () => "console.log(x);");
  const findings = await scanDebugLeftover({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/widget.test.ts", patch: patchOf(["console.log(inTest);"]) }, // skipped
      { path: "tests/helper.ts", patch: patchOf(["console.log(inTestsDir);"]) }, // skipped
      { path: "src/widget.ts", patch: patchOf(consoleLines) }, // 25 (global cap)
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/widget.ts"));
});

test("scanDebugLeftover: no files yields no findings", async () => {
  assert.deepEqual(await scanDebugLeftover({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: debug-leftover findings render location plus a public-safe explanation only", () => {
  const { promptSection } = renderBrief({
    debugLeftover: [
      { file: "src/widget.ts", line: 2, kind: "debugger" },
      { file: "src/app.py", line: 9, kind: "print" },
    ],
  });
  assert.match(promptSection, /Leftover debug statements/);
  assert.match(promptSection, /src\/widget\.ts:2/);
  assert.match(promptSection, /debugger;` statement/);
  assert.match(promptSection, /src\/app\.py:9/);
  assert.match(promptSection, /bare `print/);
});
