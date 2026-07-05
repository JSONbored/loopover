// Units for the breaking-API-change analyzer (#1510). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// do not collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanApiBreak,
  isPublicEntrypoint,
  exportedNames,
  removedExports,
} from "../dist/analyzers/api-break.js";
import { renderBrief } from "../dist/render.js";

// Build a one-hunk unified-diff patch. `oldStart` sets the -N old-file start in the header. Each entry is
// [prefix, text] with prefix "-", "+", or " " (context).
const hunk = (lines, oldStart = 1) =>
  `@@ -${oldStart},0 +${oldStart},0 @@\n${lines.map(([p, t]) => `${p}${t}`).join("\n")}`;

test("isPublicEntrypoint: recognizes barrel/entry source files; rejects internal, decl, and test files", () => {
  assert.equal(isPublicEntrypoint("src/index.ts"), true);
  assert.equal(isPublicEntrypoint("mod.ts"), true);
  assert.equal(isPublicEntrypoint("packages/x/src/main.js"), true);
  assert.equal(isPublicEntrypoint("src/public-api.ts"), true);
  assert.equal(isPublicEntrypoint("api.mts"), true);
  assert.equal(isPublicEntrypoint("src/util.ts"), false);
  assert.equal(isPublicEntrypoint("src/index.d.ts"), false);
  assert.equal(isPublicEntrypoint("src/index.test.ts"), false);
  assert.equal(isPublicEntrypoint("README.md"), false);
});

test("exportedNames: extracts each top-level declaration form", () => {
  assert.deepEqual(exportedNames("export function alpha() {}"), ["alpha"]);
  assert.deepEqual(exportedNames("export async function beta() {}"), ["beta"]);
  assert.deepEqual(exportedNames("export function* gen() {}"), ["gen"]);
  assert.deepEqual(exportedNames("export const gamma = 1;"), ["gamma"]);
  assert.deepEqual(exportedNames("export let delta = 1;"), ["delta"]);
  assert.deepEqual(exportedNames("export var epsilon = 1;"), ["epsilon"]);
  assert.deepEqual(exportedNames("export class Zeta {}"), ["Zeta"]);
  assert.deepEqual(exportedNames("export abstract class Eta {}"), ["Eta"]);
  assert.deepEqual(exportedNames("export interface Theta {}"), ["Theta"]);
  assert.deepEqual(exportedNames("export type Iota = string;"), ["Iota"]);
  assert.deepEqual(exportedNames("export enum Kappa { A }"), ["Kappa"]);
  assert.deepEqual(exportedNames("export const enum Lambda { A }"), ["Lambda"]);
});

test("exportedNames: resolves re-exports, aliases, default, and star-as; ignores bare star and non-exports", () => {
  assert.deepEqual(exportedNames('export { a, b } from "./x";'), ["a", "b"]);
  assert.deepEqual(exportedNames('export { internal as publicName } from "./x";'), ["publicName"]);
  assert.deepEqual(exportedNames("export { c };"), ["c"]);
  assert.deepEqual(exportedNames('export type { T, U } from "./types";'), ["T", "U"]);
  assert.deepEqual(exportedNames("export default function main() {}"), ["default"]);
  assert.deepEqual(exportedNames("export default foo;"), ["default"]);
  assert.deepEqual(exportedNames('export * as ns from "./x";'), ["ns"]);
  assert.deepEqual(exportedNames('export * from "./x";'), []);
  assert.deepEqual(exportedNames("const notExported = 1;"), []);
  assert.deepEqual(exportedNames("  export const indented = 1;"), []);
});

test("removedExports: flags a removed declaration export not re-added, at its old-file line", () => {
  const out = removedExports(
    hunk([[" ", "line0"], ["-", "export function gone() {}"], [" ", "kept"]], 10),
  );
  assert.deepEqual(out, [{ symbol: "gone", line: 11 }]);
});

test("removedExports: does not flag a same-name edit (removed and re-added)", () => {
  const out = removedExports(hunk([["-", "export const cfg = 1;"], ["+", "export const cfg = 2;"]]));
  assert.deepEqual(out, []);
});

test("removedExports: flags a rename (old name dropped, new name added)", () => {
  const out = removedExports(
    hunk([["-", "export function oldName() {}"], ["+", "export function newName() {}"]]),
  );
  assert.deepEqual(out, [{ symbol: "oldName", line: 1 }]);
});

test("removedExports: flags a name dropped from a re-export list", () => {
  const out = removedExports(
    hunk([["-", 'export { a, b } from "./x";'], ["+", 'export { a } from "./x";']]),
  );
  assert.deepEqual(out, [{ symbol: "b", line: 1 }]);
});

test("scanApiBreak: flags a removed export in an entrypoint, ignores internal modules", async () => {
  const findings = await scanApiBreak({
    repoFullName: "owner/repo",
    prNumber: 1,
    files: [
      { path: "src/index.ts", patch: hunk([["-", "export function removed() {}"]]) },
      { path: "src/internal.ts", patch: hunk([["-", "export function alsoRemoved() {}"]]) },
    ],
  });
  assert.deepEqual(findings, [{ file: "src/index.ts", line: 1, symbol: "removed" }]);
});

test("scanApiBreak: fail-safe with no files, a patch-less entrypoint, and an added-only entrypoint", async () => {
  assert.deepEqual(await scanApiBreak({ repoFullName: "o/r", prNumber: 1 }), []);
  assert.deepEqual(
    await scanApiBreak({ repoFullName: "o/r", prNumber: 1, files: [{ path: "src/index.ts" }] }),
    [],
  );
  assert.deepEqual(
    await scanApiBreak({
      repoFullName: "o/r",
      prNumber: 1,
      files: [{ path: "src/index.ts", patch: hunk([["+", "export const added = 1;"]]) }],
    }),
    [],
  );
});

test("scanApiBreak: returns [] when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const findings = await scanApiBreak(
    {
      repoFullName: "o/r",
      prNumber: 1,
      files: [{ path: "src/index.ts", patch: hunk([["-", "export const x = 1;"]]) }],
    },
    controller.signal,
  );
  assert.deepEqual(findings, []);
});

test("scanApiBreak: caps findings at 25", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => ["-", `export const sym${i} = ${i};`]);
  const findings = await scanApiBreak({
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "src/index.ts", patch: hunk(lines) }],
  });
  assert.equal(findings.length, 25);
});

test("scanApiBreak: stops after the entrypoint cap without throwing", async () => {
  const files = Array.from({ length: 30 }, (_, i) => ({
    path: `pkg${i}/index.ts`,
    patch: hunk([[" ", "// no export removed"]]),
  }));
  assert.deepEqual(await scanApiBreak({ repoFullName: "o/r", prNumber: 1, files }), []);
});

test("renderBrief: includes apiBreak findings via the descriptor render", () => {
  const { promptSection } = renderBrief({
    apiBreak: [{ file: "src/index.ts", line: 7, symbol: "publicApi" }],
  });
  assert.match(promptSection, /Breaking API changes/);
  assert.match(promptSection, /publicApi/);
  assert.match(promptSection, /src\/index\.ts:7/);
});
