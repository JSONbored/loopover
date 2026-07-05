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

test("detectUnsafeAny: classifies annotation, cast, and assertion patterns", () => {
  assert.equal(detectUnsafeAny("const value: any = input;"), "annotation");
  assert.equal(detectUnsafeAny("function run(payload: any) {}"), "annotation");
  assert.equal(detectUnsafeAny("return data as any;"), "cast");
  assert.equal(detectUnsafeAny("const rows = (items as any).map(fn);"), "cast");
  assert.equal(detectUnsafeAny("const rows = get<any>();"), "assertion");
  assert.equal(detectUnsafeAny("type Rows = Array<any>;"), "assertion");
});

test("detectUnsafeAny: skips comments and string-literal false positives", () => {
  assert.equal(detectUnsafeAny("// const value: any = input;"), null);
  assert.equal(detectUnsafeAny('const msg = ": any in prose";'), null);
  assert.equal(detectUnsafeAny('console.log("as any is bad");'), null);
});

test("scanPatchForUnsafeAny: flags added lines with correct locations", () => {
  const findings = scanPatchForUnsafeAny(
    "src/worker.ts",
    patchOf([
      "export function parse(input: string) {",
      "  const payload: any = JSON.parse(input);",
      "  return payload as any;",
      "}",
    ]),
  );
  assert.deepEqual(findings, [
    { file: "src/worker.ts", line: 2, kind: "annotation" },
    { file: "src/worker.ts", line: 3, kind: "cast" },
  ]);
});

test("scanPatchForUnsafeAny: skips test files and non-TS paths", () => {
  assert.deepEqual(
    scanPatchForUnsafeAny("src/worker.test.ts", patchOf(["const x: any = 1;"])),
    [],
  );
  assert.deepEqual(
    scanPatchForUnsafeAny("lib/worker.py", patchOf(["x: any = 1"])),
    [],
  );
});

test("scanPatchForUnsafeAny: caps findings at maxFindings", () => {
  const findings = scanPatchForUnsafeAny(
    "src/worker.ts",
    patchOf(["const a: any = 1;", "const b: any = 2;", "const c: any = 3;"]),
    { maxFindings: 2 },
  );
  assert.equal(findings.length, 2);
});

test("scanUnsafeAny: aggregates across files", async () => {
  const findings = await scanUnsafeAny({
    repoFullName: "owner/repo",
    prNumber: 1,
    files: [
      { path: "src/a.ts", patch: patchOf(["const x: any = 1;"]) },
      { path: "src/b.ts", patch: patchOf(["return value as any;"]) },
    ],
  });
  assert.equal(findings.length, 2);
  assert.equal(findings[0]?.kind, "annotation");
  assert.equal(findings[1]?.kind, "cast");
});

test("renderBrief: includes unsafeAny findings via descriptor render", () => {
  const findings = [{ file: "src/a.ts", line: 4, kind: "cast" as const }];
  const { promptSection } = renderBrief({ unsafeAny: findings });
  assert.match(promptSection, /Unsafe any/);
  assert.match(promptSection, /src\/a.ts:4/);
  assert.match(promptSection, /cast/);
});
