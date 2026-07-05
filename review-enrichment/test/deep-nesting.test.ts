// Units for the deep-nesting analyzer (#2030). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceBraceDepth,
  DEFAULT_MAX_DEPTH,
  scanDeepNesting,
  scanPatchForDeepNesting,
} from "../dist/analyzers/deep-nesting.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("advanceBraceDepth: tracks open braces and never goes negative", () => {
  assert.deepEqual(advanceBraceDepth("", 0), { depth: 0, peak: 0 });
  assert.deepEqual(advanceBraceDepth("{", 0), { depth: 1, peak: 1 });
  assert.deepEqual(advanceBraceDepth("}}", 1), { depth: 0, peak: 1 });
  assert.deepEqual(advanceBraceDepth("{{", 0), { depth: 2, peak: 2 });
  assert.deepEqual(advanceBraceDepth("{{}}", 0), { depth: 0, peak: 2 });
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
  const deepLine = "{".repeat(DEFAULT_MAX_DEPTH + 2);
  assert.deepEqual(scanPatchForDeepNesting("src/widget.test.ts", patchOf([deepLine])), []);
  const patch = Array.from({ length: 30 }, (_, i) =>
    [`@@ -${i},0 +${i + 1},1 @@`, `+${deepLine}`].join("\n"),
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
