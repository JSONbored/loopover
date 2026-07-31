// The dead-export check's own behaviour (#9852), driven through its injectable seams so no fixture is
// written into the real tree — same pattern as check-dead-source-files-script.test.ts.
import { describe, expect, it } from "vitest";
import { findDeadExports } from "../../scripts/check-dead-exports";

/** A tiny two-root world: `src` is checked, `test` only contributes references. */
function world(files: Record<string, string>) {
  return {
    listFiles: (root: string) => Object.keys(files).filter((path) => path.startsWith(`${root}/`)),
    readFile: (file: string) => files[file] ?? "",
  };
}

describe("findDeadExports (#9852)", () => {
  it("flags an export nothing outside its own file references", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src", "test"],
      ...world({
        "src/lonely.ts": "export const LONELY = 1;\nconst used = LONELY + 1;\nexport function keep() { return used; }\n",
        "src/consumer.ts": "import { keep } from './lonely';\nkeep();\n",
        "test/x.test.ts": "",
      }),
    });
    expect(found.map((v) => v.symbol)).toEqual(["LONELY"]);
  });

  it("reports internalUses, because that decides the fix", () => {
    // >1 means the symbol is used inside the file and only `export` is wrong; 1 means it is dead outright.
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/a.ts": "export const USED_INSIDE = 1;\nconst x = USED_INSIDE;\nexport const NEVER = 2;\nvoid x;\n" }),
    });
    expect(found.find((v) => v.symbol === "USED_INSIDE")?.internalUses).toBeGreaterThan(1);
    expect(found.find((v) => v.symbol === "NEVER")?.internalUses).toBe(1);
  });

  it("counts a reference from ANY reference root, including tests and scripts", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src", "test", "scripts"],
      ...world({
        "src/a.ts": "export const FROM_TEST = 1;\nexport const FROM_SCRIPT = 2;\n",
        "test/a.test.ts": "FROM_TEST;",
        "scripts/a.ts": "FROM_SCRIPT;",
      }),
    });
    expect(found).toEqual([]);
  });

  it("honours an allowlist entry, which is keyed file:symbol", () => {
    const files = { "src/a.ts": "export const ALLOWED = 1;\n" };
    expect(findDeadExports({ sourceRoots: ["src"], referenceRoots: ["src"], ...world(files) }).map((v) => v.symbol)).toEqual(["ALLOWED"]);
    expect(
      findDeadExports({
        sourceRoots: ["src"],
        referenceRoots: ["src"],
        allowedExports: new Map([["src/a.ts:ALLOWED", "because"]]),
        ...world(files),
      }),
    ).toEqual([]);
  });

  it("ignores exported TYPES — an unused type costs nothing at runtime", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/a.ts": "export type Unused = { a: 1 };\nexport interface AlsoUnused { b: 2 }\n" }),
    });
    expect(found).toEqual([]);
  });

  it("does not confuse a substring for a reference", () => {
    // `FOO` must not be considered referenced by `FOOBAR` — the whole point of the word boundary.
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/a.ts": "export const FOO = 1;\n", "src/b.ts": "const FOOBAR = 2;\nvoid FOOBAR;\n" }),
    });
    expect(found.map((v) => v.symbol)).toEqual(["FOO"]);
  });
});

describe("findDeadExports class/enum (#10047)", () => {
  it("REGRESSION (#10047): flags an orphan export class with internalUses including the declaration", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "export class Orphan {}\nconst y = new Orphan();\n" }),
    });
    expect(found).toEqual([{ file: "src/x.ts", symbol: "Orphan", internalUses: 2 }]);
  });

  it("flags an orphan export enum with no other reference", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "export enum Kind { A }\n" }),
    });
    expect(found.map((v) => v.symbol)).toEqual(["Kind"]);
  });

  it("does not flag a class referenced from another file (external > 0 early-break)", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({
        "src/x.ts": "export class Used {}\n",
        "src/y.ts": "new Used();\n",
      }),
    });
    expect(found).toEqual([]);
  });

  it("REGRESSION (#10047): export abstract class is matched — abstract must not defeat the anchor", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "export abstract class Base {}\n" }),
    });
    expect(found.map((v) => v.symbol)).toEqual(["Base"]);
  });

  it("does NOT match a non-exported class Foo {}", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "class Foo {}\nvoid Foo;\n" }),
    });
    expect(found).toEqual([]);
  });

  it("still does NOT match export type / export interface", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/a.ts": "export type T = 1;\nexport interface I { x: 1 }\n" }),
    });
    expect(found).toEqual([]);
  });

  it("export const enum Kind is matched as Kind (const enum before bare const in the alternation)", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "export const enum Kind { A }\n" }),
    });
    expect(found.map((v) => v.symbol)).toEqual(["Kind"]);
  });

  it("class with internalUses > 1 still reports the drop-export hint path", () => {
    const found = findDeadExports({
      sourceRoots: ["src"],
      referenceRoots: ["src"],
      ...world({ "src/x.ts": "export class Inside {}\nconst z = new Inside();\n" }),
    });
    expect(found.find((v) => v.symbol === "Inside")?.internalUses).toBeGreaterThan(1);
  });
});
