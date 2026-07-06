// Units for the deep-nesting analyzer (#2030). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  advanceControlFlowDepth,
  DEFAULT_MAX_DEPTH,
  isControlFlowOpenBrace,
  scanDeepNesting,
  scanPatchForDeepNesting,
} from "../dist/analyzers/deep-nesting.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("isControlFlowOpenBrace: distinguishes control-flow from object literals", () => {
  const ifLine = "if (a) {";
  assert.equal(isControlFlowOpenBrace(ifLine, ifLine.length - 1), true);
  const objLine = "const cfg = {";
  assert.equal(isControlFlowOpenBrace(objLine, objLine.length - 1), false);
  const arrowLine = "items.map(x => {";
  assert.equal(isControlFlowOpenBrace(arrowLine, arrowLine.length - 1), true);
});

test("advanceControlFlowDepth: tracks control-flow braces, not object literals", () => {
  assert.deepEqual(advanceControlFlowDepth("", 0), { depth: 0, peak: 0 });
  assert.deepEqual(advanceControlFlowDepth("if (a) {", 0), { depth: 1, peak: 1 });
  assert.deepEqual(advanceControlFlowDepth("const cfg = { a: { b: {", 0), { depth: 0, peak: 0 });
  assert.deepEqual(advanceControlFlowDepth("if (a) { foo({ x: 1 }); }", 0), { depth: 0, peak: 1 });
});

test("advanceControlFlowDepth: handles brace-heavy lines in linear time", () => {
  const maliciousLine = `if (${"a".repeat(1900)}) ${"{".repeat(50)}`;
  const start = performance.now();

  for (let i = 0; i < 100; i++) {
    assert.deepEqual(advanceControlFlowDepth(maliciousLine, 0), { depth: 1, peak: 1 });
  }

  assert.ok(performance.now() - start < 500);
});

test("scanPatchForDeepNesting: flags a deeply nested added block", () => {
  const lines = [
    "function run() {",
    "  if (a) {",
    "    if (b) {",
    "      if (c) {",
    "        if (d) {",
    "          return x;",
    "        }",
    "      }",
    "    }",
    "  }",
    "}",
  ];
  const findings = scanPatchForDeepNesting("src/widget.ts", patchOf(lines));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.depth, DEFAULT_MAX_DEPTH + 1);
  assert.equal(findings[0]?.threshold, DEFAULT_MAX_DEPTH);
});

test("scanPatchForDeepNesting: does not flag deeply nested object literals", () => {
  const lines = [
    "export const cfg = {",
    "  a: {",
    "    b: {",
    "      c: {",
    "        d: {",
    "          e: 1,",
    "        },",
    "      },",
    "    },",
    "  },",
    "};",
  ];
  assert.deepEqual(scanPatchForDeepNesting("src/config.ts", patchOf(lines)), []);
});

test("scanPatchForDeepNesting: does not flag shallow nesting at the threshold", () => {
  const lines = ["function run() {", "  if (a) {", "    if (b) {", "      return x;", "    }", "  }", "}"];
  assert.deepEqual(scanPatchForDeepNesting("src/widget.ts", patchOf(lines)), []);
});

test("scanPatchForDeepNesting: respects a custom maxDepth limit", () => {
  const lines = ["if (a) {", "  if (b) {", "    return x;", "  }", "}"];
  assert.deepEqual(
    scanPatchForDeepNesting("src/widget.ts", patchOf(lines), { maxDepth: 1 }),
    [{ file: "src/widget.ts", line: 2, depth: 2, threshold: 1 }],
  );
  assert.deepEqual(scanPatchForDeepNesting("src/widget.ts", patchOf(lines), { maxDepth: 2 }), []);
});

test("scanPatchForDeepNesting: resets depth across context lines", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " function outer() {",
    "+  if (a) {",
    "    return x;",
    "+    if (b) { if (c) { if (d) { if (e) { if (f) { return y; } } } } }",
  ].join("\n");
  assert.equal(scanPatchForDeepNesting("src/widget.ts", patch).length, 1);
});

test("scanPatchForDeepNesting: skips test files and respects the cap", () => {
  const deepLine = "if (a) {".repeat(DEFAULT_MAX_DEPTH + 2);
  assert.deepEqual(scanPatchForDeepNesting("src/widget.test.ts", patchOf([deepLine])), []);
  const patch = Array.from({ length: 30 }, (_, i) =>
    [`@@ -${i},0 +${i + 1},1 @@`, `+${"if (x) {".repeat(DEFAULT_MAX_DEPTH + 2)}`].join("\n"),
  ).join("\n");
  assert.equal(scanPatchForDeepNesting("src/a.ts", patch, { maxFindings: 2 }).length, 2);
});

test("scanDeepNesting: aggregates across files and renders a public-safe brief", async () => {
  const deepBlock = ["if (a) {", "  if (b) {", "    if (c) {", "      if (d) {", "        if (e) {", "        }", "      }", "    }", "  }", "}"];
  const findings = await scanDeepNesting({
    files: [{ path: "src/a.ts", patch: patchOf(deepBlock) }],
  });
  assert.equal(findings.length, 1);
  const { promptSection } = renderBrief({ deepNesting: findings });
  assert.match(promptSection, /Deep nesting/);
  assert.match(promptSection, /src\/a\.ts:/);
});
