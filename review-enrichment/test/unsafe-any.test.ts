// Units for the unsafe-`any` analyzer's pure detector + its rendering (#2017). Kept separate so analyzer PRs avoid
// collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanPatchForUnsafeAny, scanUnsafeAny } from "../dist/analyzers/unsafe-any.js";
import { renderBrief } from "../dist/render.js";

function patch(...lines) {
  return lines.join("\n");
}

test("scanPatchForUnsafeAny flags a `: any` annotation with its new-file line", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch("@@ -1,1 +1,2 @@", " const a = 1;", "+let b: any = 2;"),
  );
  assert.deepEqual(findings, [{ file: "src/x.ts", line: 2, kind: "annotation" }]);
});

test("scanPatchForUnsafeAny flags an `as any` cast", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch("@@ -1 +1,1 @@", "+const y = value as any;"),
  );
  assert.deepEqual(findings, [{ file: "src/x.ts", line: 1, kind: "cast" }]);
});

test("scanPatchForUnsafeAny flags an `<any>` angle-bracket assertion", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch("@@ -1 +1,1 @@", "+const z = <any>value;"),
  );
  assert.deepEqual(findings, [{ file: "src/x.ts", line: 1, kind: "assertion" }]);
});

test("scanPatchForUnsafeAny does NOT mislabel a generic type argument as an `<any>` assertion", () => {
  // `Promise<any>` / `Array<any>` are generic arguments, not `<any>value` assertions — reporting them "assertion"
  // would be factually wrong (and `<any>` assertions aren't even legal in .tsx). Under-reporting them is fail-safe.
  const generics = scanPatchForUnsafeAny(
    "src/x.ts",
    patch("@@ -1 +1,2 @@", "+function f(): Promise<any> { return g(); }", "+const xs: Array<any> = [];"),
  );
  // `Array<any>` is caught by its `: Array` … no `: any`; both `<any>` occurrences are generic args → no assertion.
  assert.deepEqual(generics, []);
  // A genuine prefix assertion IS still flagged.
  const real = scanPatchForUnsafeAny("src/x.ts", patch("@@ -1 +1,1 @@", "+const z = <any>value;"));
  assert.deepEqual(real, [{ file: "src/x.ts", line: 1, kind: "assertion" }]);
});

test("scanUnsafeAny skips a non-TS file and generated declarations", async () => {
  const files = [
    { path: "src/x.js", patch: patch("@@ -1 +1,1 @@", "+let b: any = 2;") },
    { path: "src/x.d.ts", patch: patch("@@ -1 +1,1 @@", "+export let b: any;") },
    { path: "src/x.ts", patch: patch("@@ -1 +1,1 @@", "+let b: any = 2;") },
  ];
  const findings = await scanUnsafeAny({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1,
    files,
  });
  assert.deepEqual(findings, [{ file: "src/x.ts", line: 1, kind: "annotation" }]);
});

test("scanPatchForUnsafeAny ignores comment lines and identifiers that merely contain `any` (best-effort)", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch(
      "@@ -1 +1,5 @@",
      "+// x: any goes here",
      "+ * @returns any value",
      "+let count: number = anyThing;",
      "+const many = 3;",
      "+let live: any = q; // as any",
    ),
  );
  // Only the last line matches — its `: any` annotation; the trailing `// as any` comment is stripped, so the
  // cast inside it is NOT counted.
  assert.deepEqual(findings, [{ file: "src/x.ts", line: 5, kind: "annotation" }]);
});

test("scanPatchForUnsafeAny does not flag `any` tokens inside string literals (best-effort)", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch(
      "@@ -1 +1,2 @@",
      '+throw new Error("cast x as any");',
      "+const label = 'value: any';",
    ),
  );
  // Both `any` occurrences live inside string literals, which are blanked before matching → no findings.
  assert.deepEqual(findings, []);
});

test("scanPatchForUnsafeAny honours the maxFindings cap", () => {
  const findings = scanPatchForUnsafeAny(
    "src/x.ts",
    patch(
      "@@ -1 +1,3 @@",
      "+let a: any = 1;",
      "+let b: any = 2;",
      "+let c: any = 3;",
    ),
    { maxFindings: 2 },
  );
  assert.equal(findings.length, 2);
});

test("scanUnsafeAny returns no findings on clean input, and render emits nothing for empty", async () => {
  const findings = await scanUnsafeAny({
    repoFullName: "JSONbored/gittensory",
    prNumber: 1,
    files: [
      { path: "src/x.ts", patch: patch("@@ -1 +1,1 @@", "+let n: number = 1;") },
    ],
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(renderBrief({ unsafeAny: [] }), {
    promptSection: "",
    systemSuffix: "",
  });
});

test("renderBrief renders the unsafe-`any` section from findings", () => {
  const { promptSection } = renderBrief({
    unsafeAny: [{ file: "src/x.ts", line: 2, kind: "annotation" }],
  });
  assert.match(promptSection, /Unsafe `any` usage/);
  assert.match(promptSection, /src\/x\.ts:2/);
  assert.match(promptSection, /annotation/);
});
