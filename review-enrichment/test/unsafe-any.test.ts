// Units for the unsafe-any analyzer (#2017). Own file so concurrent analyzer PRs don't collide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectUnsafeAny,
  scanPatchForUnsafeAny,
  scanUnsafeAny,
} from "../dist/analyzers/unsafe-any.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines: string[]) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectUnsafeAny: flags annotation, cast, and assertion shapes", () => {
  assert.equal(detectUnsafeAny("const x: any = 1;"), "annotation");
  assert.equal(detectUnsafeAny("function f(v: any | null) {}"), "annotation");
  assert.equal(detectUnsafeAny("return payload as any;"), "cast");
  assert.equal(detectUnsafeAny("const rows = <any>data;"), "assertion");
});

test("detectUnsafeAny: prefers cast over annotation on the same line", () => {
  assert.equal(detectUnsafeAny("const x: any = value as any;"), "cast");
});

test("detectUnsafeAny: ignores any inside strings and full-line comments", () => {
  assert.equal(detectUnsafeAny('const s = ": any"'), null);
  assert.equal(detectUnsafeAny('log(`typed as any inside`);'), null);
  assert.equal(detectUnsafeAny("// const x: any"), null);
});

test("detectUnsafeAny: ignores inline block comments after real code", () => {
  assert.equal(detectUnsafeAny("const x = 1; /* as any */"), null);
  assert.equal(detectUnsafeAny("/* @internal */ const value: any = input;"), "annotation");
});

test("scanPatchForUnsafeAny: flags added lines with correct locations", () => {
  const findings = scanPatchForUnsafeAny(
    "src/widget.ts",
    patchOf(["function load(): any {", "  return data as any;", "}"]),
  );
  assert.deepEqual(findings, [
    { file: "src/widget.ts", line: 1, kind: "annotation" },
    { file: "src/widget.ts", line: 2, kind: "cast" },
  ]);
});

test("scanPatchForUnsafeAny: ignores multi-line block comments on added lines", () => {
  const patch = ["@@ -1,0 +1,3 @@", "+/*", "+ * const x: any = 1;", "+ */"].join("\n");
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patch), []);
});

test("scanPatchForUnsafeAny: ignores added lines inside a context-opened block comment", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " function foo() {",
    " /*",
    "+ * value: any",
    " */",
  ].join("\n");
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patch), []);
});

test("scanPatchForUnsafeAny: skips non-TS files, test paths, and respects the cap", () => {
  assert.deepEqual(scanPatchForUnsafeAny("src/widget.js", patchOf(["const x: any = 1;"])), []);
  assert.deepEqual(
    scanPatchForUnsafeAny("src/widget.test.ts", patchOf(["const x: any = 1;"])),
    [],
  );
  const lines = Array.from({ length: 30 }, () => "const x: any = 1;");
  assert.equal(scanPatchForUnsafeAny("src/a.ts", patchOf(lines), { maxFindings: 3 }).length, 3);
});

test("scanUnsafeAny: aggregates across files and renders a public-safe brief", async () => {
  const findings = await scanUnsafeAny({
    files: [
      { path: "src/a.ts", patch: patchOf(["const x: any = 1;"]) },
      { path: "lib/b.tsx", patch: patchOf(["return value as any;"]) },
    ],
  });
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, kind: "annotation" },
    { file: "lib/b.tsx", line: 1, kind: "cast" },
  ]);
  const { promptSection } = renderBrief({ unsafeAny: findings });
  assert.match(promptSection, /Unsafe `any`/);
  assert.match(promptSection, /src\/a\.ts:1/);
});
