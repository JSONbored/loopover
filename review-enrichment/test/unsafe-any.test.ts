// Units for the unsafe-`any` counter analyzer (#2017). Own file (not enrichment.test.ts) so concurrent analyzer
// PRs don't collide. No network — pure, stateless per-line detection. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectUnsafeAny,
  scanPatchForUnsafeAny,
  scanUnsafeAny,
} from "../dist/analyzers/unsafe-any.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("detectUnsafeAny: distinguishes annotation, cast, and assertion", () => {
  assert.deepEqual(detectUnsafeAny("function f(x: any) {"), ["annotation"]);
  assert.deepEqual(detectUnsafeAny("const y = x as any;"), ["cast"]);
  assert.deepEqual(detectUnsafeAny("const z = <any>x;"), ["assertion"]);
  assert.deepEqual(detectUnsafeAny("const w: Array<any> = [];"), ["assertion"]);
});

test("detectUnsafeAny: an `any` inside a multi-argument or compound generic type argument is an assertion finding", () => {
  // Regression: the type-argument matcher must see explicit `any` inside a `<…>` list that has other tokens,
  // not only the bare `<any>` token.
  assert.deepEqual(detectUnsafeAny("const x: Record<string, any> = {};"), ["assertion"]);
  assert.deepEqual(detectUnsafeAny("let p: Promise<any[]> = load();"), ["assertion"]);
  assert.deepEqual(detectUnsafeAny("const m: Map<string, any> = new Map();"), ["assertion"]);
  assert.deepEqual(detectUnsafeAny("function f<T>(): Map<K, Set<any>> { return x; }"), ["assertion"]);
  // A generic with no `any` argument is not flagged.
  assert.deepEqual(detectUnsafeAny("const r: Record<string, number> = {};"), []);
});

test("detectUnsafeAny: multiple distinct kinds on one line are each reported (deduped by kind)", () => {
  // cast + assertion + annotation, deduped so a repeated kind is not double-counted on the same line.
  const kinds = detectUnsafeAny("let a: any = (x as any) as any; const b = <any>c;");
  assert.deepEqual([...kinds].sort(), ["annotation", "assertion", "cast"]);
});

test("detectUnsafeAny: word-boundary — anyOf/anything/Company are not matched", () => {
  assert.deepEqual(detectUnsafeAny("const o: anyOf = pick();"), []);
  assert.deepEqual(detectUnsafeAny("let s = 'has anything';"), []);
  assert.deepEqual(detectUnsafeAny("class Company {}"), []);
});

test("detectUnsafeAny: `any` inside a string literal or comment is not counted", () => {
  assert.deepEqual(detectUnsafeAny('const msg = "cast as any here";'), []);
  assert.deepEqual(detectUnsafeAny("const n = 1; // treat as any value"), []);
  assert.deepEqual(detectUnsafeAny("doStuff(); /* returns : any */"), []);
  assert.deepEqual(detectUnsafeAny("   * @param p : any description"), []); // JSDoc continuation
});

test("detectUnsafeAny: real code with a trailing comment is still counted", () => {
  assert.deepEqual(detectUnsafeAny("const v: any = load(); // TODO type this"), ["annotation"]);
});

test("detectUnsafeAny: a generator method starting with `*` is code, not a JSDoc line — its `: any` is counted", () => {
  // Regression: the JSDoc guard must skip only `* `/`*`/`*/` continuation shapes, never a `*name(): any` method.
  assert.deepEqual(detectUnsafeAny("  *load(): any {}"), ["annotation"]);
  assert.deepEqual(detectUnsafeAny("  *items(): Generator<any> {}"), ["assertion"]);
  // …while a genuine JSDoc continuation line is still skipped.
  assert.deepEqual(detectUnsafeAny("   * @returns {any} the value"), []);
  assert.deepEqual(detectUnsafeAny("   */"), []);
});

test("scanPatchForUnsafeAny: only scans TS-family files", () => {
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patchOf(["let x: any;"])), [
    { file: "src/a.ts", line: 1, kind: "annotation" },
  ]);
  assert.deepEqual(scanPatchForUnsafeAny("src/a.tsx", patchOf(["let x: any;"])), [
    { file: "src/a.tsx", line: 1, kind: "annotation" },
  ]);
  // A .js/.py/.md file is not TypeScript — not scanned.
  assert.deepEqual(scanPatchForUnsafeAny("src/a.js", patchOf(["let x = y; // as any"])), []);
  assert.deepEqual(scanPatchForUnsafeAny("docs/notes.md", patchOf(["use `as any` sparingly"])), []);
});

test("scanPatchForUnsafeAny: flags kinds on added lines with correct locations", () => {
  const findings = scanPatchForUnsafeAny(
    "src/svc.ts",
    patchOf(["function f(p: any) {", "  return p as any;", "  const clean: string = p;", "}"]),
  );
  assert.deepEqual(findings, [
    { file: "src/svc.ts", line: 1, kind: "annotation" },
    { file: "src/svc.ts", line: 2, kind: "cast" },
  ]);
});

test("scanPatchForUnsafeAny: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function f() {", // context line 10
    "-  let x: any;", // removed, does not advance
    "+  let x: any;", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, kind: "annotation" },
  ]);
});

test("scanPatchForUnsafeAny: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, () => "let x: any;");
  const findings = scanPatchForUnsafeAny("src/a.ts", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(scanPatchForUnsafeAny("src/a.ts", patchOf(lines), { maxFindings: 0 }), []);
});

test("scanUnsafeAny: scans every changed TS file and honors the global cap", async () => {
  const anyLines = Array.from({ length: 30 }, () => "let x: any;");
  const findings = await scanUnsafeAny({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/a.js", patch: patchOf(["let x = 1;"]) }, // skipped (not TS)
      { path: "src/b.ts", patch: patchOf(anyLines) },
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/b.ts"));
});

test("scanUnsafeAny: no files yields no findings", async () => {
  assert.deepEqual(await scanUnsafeAny({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: unsafe-any findings render location and a public-safe explanation", () => {
  const { promptSection } = renderBrief({
    unsafeAny: [
      { file: "src/svc.ts", line: 1, kind: "annotation" },
      { file: "src/svc.ts", line: 2, kind: "cast" },
    ],
  });
  assert.match(promptSection, /Unsafe .any. usage/);
  assert.match(promptSection, /src\/svc\.ts:1/);
  assert.match(promptSection, /type annotation/);
});
