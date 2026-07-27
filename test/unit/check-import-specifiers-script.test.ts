import { describe, expect, it } from "vitest";
import { findImportSpecifierViolations } from "../../scripts/check-import-specifiers";

function fakeFiles(byFile: Record<string, string>): { listSourceFiles: (root: string) => string[]; readFile: (file: string) => string } {
  const files = Object.keys(byFile);
  return {
    listSourceFiles: (root) => files.filter((f) => f.startsWith(`${root}/`)),
    readFile: (file) => byFile[file] ?? "",
  };
}

describe("check-import-specifiers script", () => {
  it("flags a .js relative specifier inside the bundler zone (src/scripts/test)", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: [],
      ...fakeFiles({ "src/foo.ts": 'import { bar } from "./bar.js";' }),
    });
    expect(violations).toEqual([{ file: "src/foo.ts", specifier: "./bar.js", reason: "this file's zone (src/scripts/test) resolves extensionless under Bundler" }]);
  });

  it("does not flag an extensionless relative specifier in the bundler zone (the correct form)", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: [],
      ...fakeFiles({ "src/foo.ts": 'import { bar } from "./bar";' }),
    });
    expect(violations).toEqual([]);
  });

  it("flags a bare (no-extension) relative specifier inside a NodeNext package", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: [],
      nodeNextRoots: ["packages"],
      ...fakeFiles({ "packages/engine/src/foo.ts": 'import { bar } from "./bar";' }),
    });
    expect(violations).toEqual([{ file: "packages/engine/src/foo.ts", specifier: "./bar", reason: "this file's own package is NodeNext-resolved ESM and requires `.js`" }]);
  });

  it("does not flag a .js relative specifier inside a NodeNext package (the correct form)", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: [],
      nodeNextRoots: ["packages"],
      ...fakeFiles({ "packages/engine/src/foo.ts": 'import { bar } from "./bar.js";' }),
    });
    expect(violations).toEqual([]);
  });

  it("rejects a `.ts` specifier in either zone", () => {
    const bundler = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: [],
      ...fakeFiles({ "src/foo.ts": 'import { bar } from "./bar.ts";' }),
    });
    expect(bundler).toEqual([{ file: "src/foo.ts", specifier: "./bar.ts", reason: "`.ts` specifiers fail typecheck (TS5097)" }]);

    const nodenext = findImportSpecifierViolations({
      bundlerRoots: [],
      nodeNextRoots: ["packages"],
      ...fakeFiles({ "packages/engine/src/foo.ts": 'import { bar } from "./bar.ts";' }),
    });
    expect(nodenext).toEqual([{ file: "packages/engine/src/foo.ts", specifier: "./bar.ts", reason: "`.ts` specifiers fail typecheck (TS5097)" }]);
  });

  it("never flags a .d.ts declaration-only import, in either zone", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: ["packages"],
      ...fakeFiles({
        "src/foo.ts": 'import type { X } from "../packages/engine/lib/claim-ledger.d.ts";',
        "packages/engine/src/foo.ts": 'import type { X } from "./bar.d.ts";',
      }),
    });
    expect(violations).toEqual([]);
  });

  it("never flags a non-JS/TS extension (.json import assertion) even with no recognized JS/TS suffix, in either zone", () => {
    // A NodeNext package importing its own package.json (`with { type: "json" }`) needs no `.js`: the
    // extension group only recognizes .d.ts/.js/.ts, so .json falls to the "no extension captured" bucket --
    // OTHER_EXTENSION_TAIL is what stops that from being misread as a bare, extensionless module specifier.
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: ["packages"],
      ...fakeFiles({
        "packages/engine/src/version.ts": 'import pkg from "../package.json" with { type: "json" };',
        "src/theme.ts": 'import tokens from "./tokens.json";',
      }),
    });
    expect(violations).toEqual([]);
  });

  it("scans a dynamic import() the same as a static from-import", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["scripts"],
      nodeNextRoots: [],
      ...fakeFiles({ "scripts/lazy.ts": 'const mod = await import("./bar.js");' }),
    });
    expect(violations).toEqual([{ file: "scripts/lazy.ts", specifier: "./bar.js", reason: "this file's zone (src/scripts/test) resolves extensionless under Bundler" }]);
  });

  it("ignores a bare package specifier (no relative prefix) entirely", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: [],
      ...fakeFiles({ "src/foo.ts": 'import { z } from "zod";' }),
    });
    expect(violations).toEqual([]);
  });

  it("allowlists its own test file (embeds import-statement text as fixtures, not real imports of itself)", () => {
    const violations = findImportSpecifierViolations({
      bundlerRoots: ["test"],
      nodeNextRoots: [],
      ...fakeFiles({ "test/unit/check-import-specifiers-script.test.ts": 'const fixture = "import { bar } from \\"./bar.js\\";";' }),
    });
    expect(violations).toEqual([]);
  });

  it("sorts violations by file then specifier, and a missing root yields nothing (real listSourceFiles catch arm)", () => {
    const violations = findImportSpecifierViolations({ bundlerRoots: ["definitely-not-a-real-directory-xyz"], nodeNextRoots: [] });
    expect(violations).toEqual([]);

    const multi = findImportSpecifierViolations({
      bundlerRoots: ["src"],
      nodeNextRoots: [],
      ...fakeFiles({
        "src/z.ts": 'import { b } from "./b.js"; import { a } from "./a.js";',
        "src/a.ts": 'import { c } from "./c.js";',
      }),
    });
    expect(multi.map((v) => v.file)).toEqual(["src/a.ts", "src/z.ts", "src/z.ts"]);
    expect(multi.map((v) => v.specifier)).toEqual(["./c.js", "./a.js", "./b.js"]);
  });
});
