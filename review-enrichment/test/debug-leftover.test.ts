// Units for the debug-leftover analyzer (#2015). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. No network — pure, stateless per-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDebugLeftover,
  scanDebugLeftover,
  scanPatchForDebugLeftover,
} from "../dist/analyzers/debug-leftover.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectDebugLeftover: recognizes debugger, console sinks, and print()", () => {
  assert.equal(detectDebugLeftover("  debugger;"), "debugger");
  assert.equal(detectDebugLeftover("console.log('hi')"), "console");
  assert.equal(detectDebugLeftover("  console.debug(state)"), "console");
  // Additional console inspection/debug sinks left in code.
  assert.equal(detectDebugLeftover("console.group('scope')"), "console");
  assert.equal(detectDebugLeftover("  console.groupCollapsed('x')"), "console");
  assert.equal(detectDebugLeftover("console.count('hits')"), "console");
  assert.equal(detectDebugLeftover("console.dirxml(node)"), "console");
  assert.equal(detectDebugLeftover("print('debug')", "lib/b.py"), "print");
});

test("detectDebugLeftover: print() is Python-only and does not match method calls like document.print()", () => {
  assert.equal(detectDebugLeftover("document.print()"), null);
  assert.equal(detectDebugLeftover("printer.print('x')"), null);
  assert.equal(detectDebugLeftover("print('debug')", "src/widget.ts"), null);
  assert.equal(detectDebugLeftover("obj.print('x')", "pkg/widget.py"), null);
});

test("detectDebugLeftover: a console call inside a string literal is not flagged", () => {
  assert.equal(detectDebugLeftover('const s = "console.log(\\"nope\\")"'), null);
  assert.equal(detectDebugLeftover("log(`hint: console.log(here)`);"), null);
});

test("detectDebugLeftover: debugger inside a string is not flagged", () => {
  assert.equal(detectDebugLeftover('const msg = "debugger;"'), null);
});

test("scanPatchForDebugLeftover: flags added lines with correct locations", () => {
  const findings = scanPatchForDebugLeftover(
    "src/widget.ts",
    patchOf(["function f() {", "  debugger;", "  console.log('x');", "  return g();", "}"]),
  );
  assert.deepEqual(findings, [
    { file: "src/widget.ts", line: 2, kind: "debugger" },
    { file: "src/widget.ts", line: 3, kind: "console" },
  ]);
});

test("scanPatchForDebugLeftover: only ADDED lines are scanned", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {",
    "-  console.log('old');",
    "+  print('new')",
  ].join("\n");
  assert.deepEqual(scanPatchForDebugLeftover("pkg/widget.py", patch), [
    { file: "pkg/widget.py", line: 11, kind: "print" },
  ]);
});

test("scanPatchForDebugLeftover: skips test/spec files", () => {
  assert.deepEqual(
    scanPatchForDebugLeftover("src/widget.test.ts", patchOf(["console.log('in test')"])),
    [],
  );
  assert.deepEqual(
    scanPatchForDebugLeftover("tests/widget.spec.js", patchOf(["debugger;"])),
    [],
  );
});

test("scanPatchForDebugLeftover: respects the findings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `console.log(${i});`);
  assert.equal(scanPatchForDebugLeftover("src/a.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanDebugLeftover: aggregates across files and renders in the brief", async () => {
  const findings = await scanDebugLeftover({
    files: [
      { path: "src/a.ts", patch: patchOf(["debugger;"]) },
      { path: "lib/b.py", patch: patchOf(["print('x')"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, kind: "debugger" },
    { file: "lib/b.py", line: 1, kind: "print" },
  ]);

  const { promptSection } = renderBrief({
    debugLeftover: findings,
  });
  assert.match(promptSection, /Debug leftovers/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.match(promptSection, /lib\/b\.py:1/);
});
