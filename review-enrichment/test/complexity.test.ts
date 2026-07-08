// Units for the approximate cyclomatic-complexity analyzer (#1477). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countDecisionPoints,
  DEFAULT_MAX_COMPLEXITY,
  functionNameFromLine,
  scanComplexity,
  scanPatchForComplexity,
} from "../dist/analyzers/complexity.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("countDecisionPoints: counts if/for/while/catch/case and logical operators", () => {
  assert.equal(countDecisionPoints(""), 0);
  assert.equal(countDecisionPoints("if (a) {"), 1);
  assert.equal(countDecisionPoints("for (const x of y) {"), 1);
  assert.equal(countDecisionPoints("for await (const x of y) {"), 1);
  assert.equal(countDecisionPoints("while (true) {"), 1);
  assert.equal(countDecisionPoints("catch (e) {"), 1);
  assert.equal(countDecisionPoints("catch {"), 1);
  assert.equal(countDecisionPoints("case 1:"), 1);
  assert.equal(countDecisionPoints("a && b || c ?? d"), 3);
  assert.equal(countDecisionPoints("if (a) { if (b) {} }"), 2);
});

test("countDecisionPoints: does not count default, ternary, or optional chaining", () => {
  assert.equal(countDecisionPoints("default:"), 0);
  assert.equal(countDecisionPoints("const x = a ? b : c;"), 0);
  assert.equal(countDecisionPoints("a?.b ?? c"), 1);
  assert.equal(countDecisionPoints("function f(x?: number) {"), 0);
});

test("countDecisionPoints: does not falsely match identifiers containing the token as a substring", () => {
  assert.equal(countDecisionPoints("const testCase1 = getCase();"), 0);
  assert.equal(countDecisionPoints("const forecast = 1;"), 0);
});

test("functionNameFromLine: detects named functions and arrow-assigned functions", () => {
  assert.equal(functionNameFromLine("function run() {"), "run");
  assert.equal(functionNameFromLine("export function run() {"), "run");
  assert.equal(functionNameFromLine("const run = () => {"), "run");
  assert.equal(functionNameFromLine("export const run = async () => {"), "run");
  assert.equal(functionNameFromLine("const run = (x: number) => {"), "run");
});

test("functionNameFromLine: a plain (non-arrow) function expression assigned to a const is out of scope", () => {
  // Same structural scope as size-smell.ts's function detection: only named `function` declarations and
  // arrow functions are recognized, not a bare `function` expression assigned via const/let/var.
  assert.equal(functionNameFromLine("const run = function () {"), undefined);
});

test("functionNameFromLine: returns undefined for non-function lines and comments", () => {
  assert.equal(functionNameFromLine("if (a) {"), undefined);
  assert.equal(functionNameFromLine("  return x;"), undefined);
  assert.equal(functionNameFromLine("// function run() {"), undefined);
  assert.equal(functionNameFromLine(" * function run() {"), undefined);
});

test("scanPatchForComplexity: flags a function whose approximate complexity exceeds the threshold", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const lines = [
    "function big() {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "}",
  ];
  const findings = scanPatchForComplexity("src/widget.ts", patchOf(lines));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    file: "src/widget.ts",
    line: 1,
    name: "big",
    complexity: 1 + ifCount,
    threshold: DEFAULT_MAX_COMPLEXITY,
  });
});

test("scanPatchForComplexity: does not flag a function at or under the threshold", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY - 1;
  const lines = [
    "function ok() {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "}",
  ];
  assert.deepEqual(scanPatchForComplexity("src/widget.ts", patchOf(lines)), []);
});

test("scanPatchForComplexity: scores sibling functions independently in the same hunk", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const lines = [
    "function complicated() {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "}",
    "function simple() {",
    "  if (a) {}",
    "}",
  ];
  const findings = scanPatchForComplexity("src/widget.ts", patchOf(lines));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.name, "complicated");
});

test("scanPatchForComplexity: arrow functions are scored the same as named functions", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const lines = [
    "export const big = () => {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "};",
  ];
  const findings = scanPatchForComplexity("src/widget.ts", patchOf(lines));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.name, "big");
});

test("scanPatchForComplexity: comment-only added lines do not inflate complexity", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY - 1;
  const lines = [
    "function ok() {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "  // if (extra) { would push this over the threshold if counted }",
    "}",
  ];
  assert.deepEqual(scanPatchForComplexity("src/widget.ts", patchOf(lines)), []);
});

test("scanPatchForComplexity: an edit to an existing function's body (signature not in the diff) is not scored", () => {
  const patch = [
    "@@ -5,4 +5,6 @@",
    " function existing() {",
    "+  if (a) {}",
    "+  if (b) {}",
    "   return x;",
    " }",
  ].join("\n");
  assert.deepEqual(scanPatchForComplexity("src/widget.ts", patch), []);
});

test("scanPatchForComplexity: a context line flushes an in-progress function using its partial count", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const patch = [
    "@@ -1,0 +1,3 @@",
    "+function big() {",
    ...Array.from({ length: ifCount }, (_, i) => `+  if (cond${i}) {}`),
    " // unchanged context line interrupts the run before the closing brace",
  ].join("\n");
  const findings = scanPatchForComplexity("src/widget.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.name, "big");
  assert.equal(findings[0]?.complexity, 1 + ifCount);
});

test("scanPatchForComplexity: skips non-TS/JS files and test files", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const lines = [
    "function big() {",
    ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`),
    "}",
  ];
  assert.deepEqual(scanPatchForComplexity("src/widget.py", patchOf(lines)), []);
  assert.deepEqual(scanPatchForComplexity("src/widget.test.ts", patchOf(lines)), []);
});

test("scanPatchForComplexity: respects a custom maxComplexity limit", () => {
  const lines = ["function f() {", "  if (a) {}", "  if (b) {}", "}"];
  assert.deepEqual(scanPatchForComplexity("src/widget.ts", patchOf(lines), { maxComplexity: 2 }), [
    { file: "src/widget.ts", line: 1, name: "f", complexity: 3, threshold: 2 },
  ]);
  assert.deepEqual(scanPatchForComplexity("src/widget.ts", patchOf(lines), { maxComplexity: 3 }), []);
});

test("scanPatchForComplexity: respects the findings cap across many functions", () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const functionBlock = (i: number) => [
    `function big${i}() {`,
    ...Array.from({ length: ifCount }, (_, j) => `  if (cond${j}) {}`),
    "}",
  ];
  const lines = Array.from({ length: 30 }, (_, i) => functionBlock(i)).flat();
  assert.equal(scanPatchForComplexity("src/widget.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanComplexity: aggregates across files and renders a public-safe brief", async () => {
  const ifCount = DEFAULT_MAX_COMPLEXITY + 1;
  const findings = await scanComplexity({
    files: [
      {
        path: "src/a.ts",
        patch: patchOf(["function big() {", ...Array.from({ length: ifCount }, (_, i) => `  if (cond${i}) {}`), "}"]),
      },
    ],
  });
  assert.equal(findings.length, 1);
  const { promptSection } = renderBrief({ complexity: findings });
  assert.match(promptSection, /Approximate cyclomatic complexity/);
  assert.match(promptSection, /src\/a\.ts:1/);
  assert.match(promptSection, /big/);
});
