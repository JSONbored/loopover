import { test } from "node:test";
import assert from "node:assert/strict";

import { renderRepoMap, type RepoMapFileEntry } from "../dist/index.js";

// Engine-suite (node:test) coverage for renderRepoMap's output-budget contract (#9617) so the `engine`
// Codecov flag credits the changed lines, mirroring the behavior assertions in test/unit/repo-map.test.ts.
const MARKER = "… (repo map truncated to fit the output budget)";

function symbolEntries(n: number): RepoMapFileEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `src/file${i}.ts`,
    language: "typescript",
    symbols: [{ kind: "function", name: `fn${i}`, signature: `export function fn${i}() {`, line: 1 }],
  }));
}

test("renders a complete map byte-for-byte (no marker) when everything fits", () => {
  const entry: RepoMapFileEntry = {
    path: "src/a.ts",
    language: "typescript",
    symbols: [{ kind: "function", name: "a", signature: "function a() {", line: 1 }],
  };
  const output = renderRepoMap([entry], 20_000);
  assert.equal(output, "src/a.ts:\n  function a (line 1): function a() {");
  assert.ok(!output.includes("truncated"));
});

test("keeps the output within maxOutputChars including the reserved marker", () => {
  for (const budget of [0, 5, MARKER.length - 1, MARKER.length, MARKER.length + 10, 100, 500]) {
    assert.ok(renderRepoMap(symbolEntries(40), budget).length <= budget);
  }
});

test("returns the empty string when the budget cannot hold even the marker", () => {
  assert.equal(renderRepoMap(symbolEntries(40), MARKER.length - 1), "");
});

test("returns the marker alone when the budget holds the marker but no content", () => {
  assert.equal(renderRepoMap(symbolEntries(40), MARKER.length), MARKER);
});

test("keeps the symbols that already fit alongside the reserved marker when truncating a large later symbol", () => {
  const entry: RepoMapFileEntry = {
    path: "src/multi.ts",
    language: "typescript",
    symbols: [
      { kind: "function", name: "a", signature: "function a() {", line: 1 },
      { kind: "function", name: "b", signature: "function bWithAVeryLongSignatureThatExceedsTheMarkerLength() {", line: 3 },
    ],
  };
  const headerAndFirstSymbol = "src/multi.ts:\n  function a (line 1): function a() {";
  const output = renderRepoMap([entry], headerAndFirstSymbol.length + 1 + MARKER.length);
  assert.equal(output, `${headerAndFirstSymbol}\n${MARKER}`);
});
