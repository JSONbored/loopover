import { describe, expect, it } from "vitest";
import { extractChangedSymbols, extractSymbolsFromPatch } from "../../src/review/impact-symbols";

// A unified-diff patch adding a single exported declaration line, plus a couple of context lines so the
// extractor has real hunk shape to walk.
function addPatch(declarationLine: string): string {
  return ["@@ -1,2 +1,3 @@", " context before", `+${declarationLine}`, " context after"].join("\n");
}

describe("extractSymbolsFromPatch", () => {
  it("extracts an added exported function declaration", () => {
    expect(extractSymbolsFromPatch("src/util.ts", addPatch("export function computeThing() {"))).toEqual([
      { name: "computeThing", kind: "function" },
    ]);
  });

  it("extracts an added exported async function declaration", () => {
    expect(extractSymbolsFromPatch("src/util.ts", addPatch("export async function fetchThing() {"))).toEqual([
      { name: "fetchThing", kind: "function" },
    ]);
  });

  it("extracts an added exported class declaration", () => {
    expect(extractSymbolsFromPatch("src/thing.ts", addPatch("export class Widget {"))).toEqual([
      { name: "Widget", kind: "class" },
    ]);
  });

  it("extracts an added exported const arrow-function declaration as an export boundary", () => {
    expect(extractSymbolsFromPatch("src/util.ts", addPatch("export const computeThing = () => {"))).toEqual([
      { name: "computeThing", kind: "export" },
    ]);
  });

  it("extracts an added exported type/interface/enum declaration", () => {
    expect(extractSymbolsFromPatch("src/types.ts", addPatch("export type Widget = {"))).toEqual([{ name: "Widget", kind: "export" }]);
    expect(extractSymbolsFromPatch("src/types.ts", addPatch("export interface Widget {"))).toEqual([{ name: "Widget", kind: "export" }]);
    expect(extractSymbolsFromPatch("src/types.ts", addPatch("export enum Widget {"))).toEqual([{ name: "Widget", kind: "export" }]);
  });

  it("extracts a REMOVED exported declaration (a deleted export is a real change callers need to know about)", () => {
    const patch = ["@@ -1,3 +1,2 @@", " context before", "-export function oldHelper() {", " context after"].join("\n");
    expect(extractSymbolsFromPatch("src/util.ts", patch)).toEqual([{ name: "oldHelper", kind: "function" }]);
  });

  it("extracts an exported default class/function with its name still captured", () => {
    expect(extractSymbolsFromPatch("src/widget.ts", addPatch("export default class Widget {"))).toEqual([
      { name: "Widget", kind: "class" },
    ]);
  });

  it("extracts multiple distinct symbols from the same patch", () => {
    const patch = [
      "@@ -1,2 +1,4 @@",
      "+export function computeThing() {",
      "+  return 1;",
      "+}",
      "+export function computeThing2() {",
    ].join("\n");
    expect(extractSymbolsFromPatch("src/util.ts", patch)).toEqual([
      { name: "computeThing", kind: "function" },
      { name: "computeThing2", kind: "function" },
    ]);
  });

  it("de-duplicates the SAME symbol name touched by multiple lines in one patch", () => {
    // A modified function: the diff shows the OLD signature removed and the NEW one added, both naming
    // the same exported symbol — must appear exactly once in the output, not twice.
    const patch = [
      "@@ -1,3 +1,3 @@",
      "-export function computeThing(a) {",
      "+export function computeThing(a, b) {",
      "   return a;",
    ].join("\n");
    expect(extractSymbolsFromPatch("src/util.ts", patch)).toEqual([{ name: "computeThing", kind: "function" }]);
  });

  it("ignores a non-exported (local/internal) declaration", () => {
    expect(extractSymbolsFromPatch("src/util.ts", addPatch("function localHelper() {"))).toEqual([]);
  });

  it("ignores +++ / --- file-header lines even though they start with the diff marker chars", () => {
    const patch = ["--- a/src/util.ts", "+++ b/src/util.ts", "@@ -1,1 +1,1 @@", " unchanged"].join("\n");
    expect(extractSymbolsFromPatch("src/util.ts", patch)).toEqual([]);
  });

  it("returns empty for a non-JS/TS file regardless of patch content", () => {
    expect(extractSymbolsFromPatch("src/main.py", addPatch("export function computeThing() {"))).toEqual([]);
  });

  it("returns empty for an undefined patch (fail-safe, never throws)", () => {
    expect(extractSymbolsFromPatch("src/util.ts", undefined)).toEqual([]);
  });

  it("returns empty for a patch with no recognizable declaration (malformed/unparseable diff)", () => {
    expect(extractSymbolsFromPatch("src/util.ts", "@@ -1,1 +1,1 @@\n+const x = 1;\n+// just a comment")).toEqual([]);
  });
});

describe("extractChangedSymbols", () => {
  it("maps one entry per file, with symbols extracted per patch", () => {
    const files = [
      { path: "src/a.ts", patch: addPatch("export function a() {") },
      { path: "src/b.ts", patch: addPatch("export class B {") },
    ];
    expect(extractChangedSymbols(files)).toEqual([
      { path: "src/a.ts", symbols: ["a"] },
      { path: "src/b.ts", symbols: ["B"] },
    ]);
  });

  it("includes a file with zero extracted symbols rather than dropping it (accurate file count)", () => {
    expect(extractChangedSymbols([{ path: "src/a.ts", patch: undefined }])).toEqual([{ path: "src/a.ts", symbols: [] }]);
  });

  it("returns an empty array for an empty file list", () => {
    expect(extractChangedSymbols([])).toEqual([]);
  });
});
