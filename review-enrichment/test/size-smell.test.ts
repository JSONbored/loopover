// Units for the size-smell analyzer (#2019). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_FILE_LINES,
  DEFAULT_MAX_FUNCTION_LINES,
  estimateFileLengthFromPatch,
  scanPatchForSizeSmell,
  scanSizeSmell,
} from "../dist/analyzers/size-smell.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("estimateFileLengthFromPatch: reads ending line from hunk headers", () => {
  const patch = ["@@ -0,0 +1,3 @@", "+a", "+b", "+c"].join("\n");
  assert.equal(estimateFileLengthFromPatch(patch), 3);
  assert.equal(
    estimateFileLengthFromPatch(["@@ -10,5 +10,8 @@", "+x"].join("\n")),
    17,
  );
});

test("scanPatchForSizeSmell: flags a long resulting file", () => {
  const patch = `@@ -0,0 +1,${DEFAULT_MAX_FILE_LINES + 1} @@\n${"+line\n".repeat(DEFAULT_MAX_FILE_LINES + 1)}`;
  assert.deepEqual(scanPatchForSizeSmell("src/big.ts", patch), [
    {
      file: "src/big.ts",
      kind: "long-file",
      measure: DEFAULT_MAX_FILE_LINES + 1,
      threshold: DEFAULT_MAX_FILE_LINES,
    },
  ]);
});

test("scanPatchForSizeSmell: flags a big function body added across lines", () => {
  const header = ["function big() {"];
  const body = Array.from({ length: DEFAULT_MAX_FUNCTION_LINES }, (_, i) => `  step${i}();`);
  const footer = ["}"];
  const findings = scanPatchForSizeSmell("src/widget.ts", patchOf([...header, ...body, ...footer]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "big-function");
  assert.equal(findings[0]?.name, "big");
  assert.equal(findings[0]?.measure, DEFAULT_MAX_FUNCTION_LINES + 2);
});

test("scanPatchForSizeSmell: clean sub-threshold file and function", () => {
  const lines = ["function small() {", "  return 1;", "}"];
  assert.deepEqual(scanPatchForSizeSmell("src/widget.ts", patchOf(lines)), []);
});

test("scanPatchForSizeSmell: skips test files and respects the cap", () => {
  const longPatch = `@@ -0,0 +1,${DEFAULT_MAX_FILE_LINES + 1} @@\n${"+line\n".repeat(DEFAULT_MAX_FILE_LINES + 1)}`;
  assert.deepEqual(scanPatchForSizeSmell("src/widget.test.ts", longPatch), []);
});

test("scanSizeSmell: respects the findings cap across files", async () => {
  const longPatch = `@@ -0,0 +1,${DEFAULT_MAX_FILE_LINES + 1} @@\n${"+line\n".repeat(DEFAULT_MAX_FILE_LINES + 1)}`;
  const findings = await scanSizeSmell({
    files: Array.from({ length: 30 }, (_, i) => ({ path: `src/f${i}.ts`, patch: longPatch })),
  });
  assert.equal(findings.length, 25);
});

test("scanSizeSmell: renders a public-safe brief", async () => {
  const findings = await scanSizeSmell({
    files: [{ path: "src/a.ts", patch: patchOf(["function small() {", "  return 1;", "}"]) }],
  });
  assert.deepEqual(findings, []);
  const longPatch = `@@ -0,0 +1,${DEFAULT_MAX_FILE_LINES + 5} @@\n${"+x\n".repeat(DEFAULT_MAX_FILE_LINES + 5)}`;
  const longFindings = await scanSizeSmell({
    files: [{ path: "src/b.ts", patch: longPatch }],
  });
  assert.equal(longFindings[0]?.kind, "long-file");
  const { promptSection } = renderBrief({ sizeSmell: longFindings });
  assert.match(promptSection, /Size smells/);
  assert.match(promptSection, /src\/b\.ts/);
});
