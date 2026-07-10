import { describe, expect, it } from "vitest";
import {
  buildRepoMap,
  renderRepoMap,
  resolveRepoMapLanguage,
  type LoadRepoMapLanguageFn,
  type RepoMapFileEntry,
} from "../../packages/gittensory-engine/src/index";

describe("resolveRepoMapLanguage (#4280)", () => {
  it("maps known extensions to their grammar name", () => {
    expect(resolveRepoMapLanguage("src/foo.js")).toBe("javascript");
    expect(resolveRepoMapLanguage("src/foo.mjs")).toBe("javascript");
    expect(resolveRepoMapLanguage("src/foo.cjs")).toBe("javascript");
    expect(resolveRepoMapLanguage("src/foo.jsx")).toBe("javascript");
    expect(resolveRepoMapLanguage("src/foo.ts")).toBe("typescript");
    expect(resolveRepoMapLanguage("src/foo.mts")).toBe("typescript");
    expect(resolveRepoMapLanguage("src/foo.cts")).toBe("typescript");
    expect(resolveRepoMapLanguage("src/foo.tsx")).toBe("tsx");
  });

  it("returns null for an unsupported or missing extension", () => {
    expect(resolveRepoMapLanguage("README.md")).toBeNull();
    expect(resolveRepoMapLanguage("Makefile")).toBeNull();
    expect(resolveRepoMapLanguage("src/foo.py")).toBeNull();
  });
});

describe("buildRepoMap + extractRepoMapSymbols (#4280)", () => {
  it("extracts function/class/method declarations from a real typescript parse, with 1-indexed line numbers", async () => {
    const sourceText = [
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "",
      "export class Widget {",
      "  render(): string {",
      "    return 'ok';",
      "  }",
      "}",
    ].join("\n");

    const [entry] = await buildRepoMap([{ path: "src/widget.ts", sourceText }]);
    expect(entry).toBeDefined();
    expect(entry!.language).toBe("typescript");
    expect(entry!.skipped).toBeUndefined();
    expect(entry!.symbols).toEqual([
      // The `export` keyword lives on the enclosing export_statement node, not the declaration node itself, so
      // it is not part of the extracted signature.
      {
        kind: "function",
        name: "add",
        signature: "function add(a: number, b: number): number {",
        line: 1,
      },
      { kind: "class", name: "Widget", signature: "class Widget {", line: 5 },
      {
        kind: "method",
        name: "render",
        signature: "render(): string {",
        line: 6,
      },
    ]);
  });

  it("extracts interface and type-alias declarations, distinct from a plain function/class", async () => {
    const sourceText = [
      "export interface Point {",
      "  x: number;",
      "  y: number;",
      "}",
      "",
      "export type Pair = [Point, Point];",
    ].join("\n");

    const [entry] = await buildRepoMap([
      { path: "src/geometry.ts", sourceText },
    ]);
    expect(entry!.symbols.map((s) => s.kind)).toEqual(["interface", "type"]);
    expect(entry!.symbols.map((s) => s.name)).toEqual(["Point", "Pair"]);
  });

  it("parses .tsx files with the tsx grammar and extracts a function component declaration", async () => {
    const sourceText = [
      "export function Button(props: { label: string }) {",
      "  return null;",
      "}",
    ].join("\n");
    const [entry] = await buildRepoMap([
      { path: "src/Button.tsx", sourceText },
    ]);
    expect(entry!.language).toBe("tsx");
    expect(entry!.symbols.map((s) => s.name)).toEqual(["Button"]);
  });

  it("parses plain .js with the javascript grammar", async () => {
    const [entry] = await buildRepoMap([
      { path: "src/legacy.js", sourceText: "function helper() {}\n" },
    ]);
    expect(entry!.language).toBe("javascript");
    expect(entry!.symbols).toEqual([
      {
        kind: "function",
        name: "helper",
        signature: "function helper() {}",
        line: 1,
      },
    ]);
  });

  it("truncates an overlong one-line signature and marks it with an ellipsis", async () => {
    const longBody = "x".repeat(200);
    const sourceText = `function longOne() { const ${longBody} = 1; }`;
    const [entry] = await buildRepoMap([{ path: "src/long.ts", sourceText }], {
      maxSignatureChars: 30,
    });
    expect(entry!.symbols[0]!.signature.endsWith("…")).toBe(true);
    expect(entry!.symbols[0]!.signature.length).toBe(31); // 30 chars + the ellipsis marker
  });

  it("reports an anonymous name for an unnamed class/function expression (e.g. export default class/function)", async () => {
    const [classEntry] = await buildRepoMap([
      {
        path: "src/anon-class.ts",
        sourceText: "export default class { method() {} }",
      },
    ]);
    const classSymbol = classEntry!.symbols.find((s) => s.kind === "class");
    expect(classSymbol?.name).toBe("<anonymous>");

    const [functionEntry] = await buildRepoMap([
      {
        path: "src/anon-function.ts",
        sourceText: "export default function() { return 1; }",
      },
    ]);
    const functionSymbol = functionEntry!.symbols.find(
      (s) => s.kind === "function",
    );
    expect(functionSymbol?.name).toBe("<anonymous>");
  });

  it("skips a file with an unsupported extension without attempting to load any grammar", async () => {
    let loadCalls = 0;
    const countingLoader: LoadRepoMapLanguageFn = async () => {
      loadCalls += 1;
      throw new Error("should not be called");
    };
    const [entry] = await buildRepoMap(
      [{ path: "README.md", sourceText: "# hello" }],
      {
        loadLanguage: countingLoader,
      },
    );
    expect(entry).toEqual({
      path: "README.md",
      language: null,
      symbols: [],
      skipped: "unsupported_language",
    });
    expect(loadCalls).toBe(0);
  });

  it("skips supported files that exceed the per-file source byte budget before loading a grammar", async () => {
    let loadCalls = 0;
    const countingLoader: LoadRepoMapLanguageFn = async () => {
      loadCalls += 1;
      throw new Error("should not load grammar for oversized input");
    };
    const [entry] = await buildRepoMap(
      [{ path: "src/huge.ts", sourceText: "function huge() {}" }],
      { loadLanguage: countingLoader, maxSourceBytes: 5 },
    );
    expect(entry).toEqual({
      path: "src/huge.ts",
      language: "typescript",
      symbols: [],
      skipped: "resource_limit",
    });
    expect(loadCalls).toBe(0);
  });

  it("skips files after the aggregate source byte budget is consumed", async () => {
    const entries = await buildRepoMap(
      [
        { path: "src/first.ts", sourceText: "function first() {}" },
        { path: "src/second.ts", sourceText: "function second() {}" },
      ],
      { maxTotalSourceBytes: 20 },
    );
    expect(entries[0]!.skipped).toBeUndefined();
    expect(entries[1]).toEqual({
      path: "src/second.ts",
      language: "typescript",
      symbols: [],
      skipped: "resource_limit",
    });
  });

  it("keeps one entry per input file but resource-limits files beyond the file-count budget", async () => {
    const entries = await buildRepoMap(
      [
        { path: "src/first.ts", sourceText: "function first() {}" },
        { path: "src/second.ts", sourceText: "function second() {}" },
      ],
      { maxFiles: 1 },
    );
    expect(entries[0]!.symbols.map((symbol) => symbol.name)).toEqual(["first"]);
    expect(entries[1]).toEqual({
      path: "src/second.ts",
      language: "typescript",
      symbols: [],
      skipped: "resource_limit",
    });
  });

  it("reports resource_limit when symbol extraction exceeds the AST-node budget", async () => {
    const [entry] = await buildRepoMap(
      [{ path: "src/simple.ts", sourceText: "function simple() {}" }],
      {
        maxAstNodes: 1,
      },
    );
    expect(entry).toEqual({
      path: "src/simple.ts",
      language: "typescript",
      symbols: [],
      skipped: "resource_limit",
    });
  });

  it("reports resource_limit when symbol extraction exceeds the symbol budget", async () => {
    const [entry] = await buildRepoMap(
      [
        {
          path: "src/two.ts",
          sourceText: "function one() {}\nfunction two() {}",
        },
      ],
      {
        maxSymbols: 1,
      },
    );
    expect(entry).toEqual({
      path: "src/two.ts",
      language: "typescript",
      symbols: [],
      skipped: "resource_limit",
    });
  });

  it("bounds a very long declaration name while preserving the rest of the symbol", async () => {
    const longName = `fn${"x".repeat(250)}`;
    const [entry] = await buildRepoMap([
      { path: "src/long-name.ts", sourceText: `function ${longName}() {}` },
    ]);
    expect(entry!.symbols[0]!.name.endsWith("…")).toBe(true);
    expect(entry!.symbols[0]!.name.length).toBe(201);
  });

  it("reports grammar_unavailable (not a thrown error) when the injected loader rejects", async () => {
    const failingLoader: LoadRepoMapLanguageFn = async () => {
      throw new Error("wasm load failed");
    };
    const [entry] = await buildRepoMap(
      [{ path: "src/foo.ts", sourceText: "function f() {}" }],
      {
        loadLanguage: failingLoader,
      },
    );
    expect(entry).toEqual({
      path: "src/foo.ts",
      language: "typescript",
      symbols: [],
      skipped: "grammar_unavailable",
    });
  });

  it("reports grammar_unavailable when parsing itself throws, even though the grammar loaded fine", async () => {
    const throwingParseLanguage = {} as never; // setLanguage(this) will throw inside Parser -- not a real Language
    const brokenLoader: LoadRepoMapLanguageFn = async () =>
      throwingParseLanguage;
    const [entry] = await buildRepoMap(
      [{ path: "src/foo.ts", sourceText: "function f() {}" }],
      {
        loadLanguage: brokenLoader,
      },
    );
    expect(entry).toEqual({
      path: "src/foo.ts",
      language: "typescript",
      symbols: [],
      skipped: "grammar_unavailable",
    });
  });

  it("parses multiple files of the same language correctly using the real (non-injected) default loader", async () => {
    const entries = await buildRepoMap([
      { path: "a.ts", sourceText: "function a() {}" },
      { path: "b.ts", sourceText: "function b() {}" },
      { path: "c.ts", sourceText: "function c() {}" },
    ]);
    expect(
      entries.every(
        (entry) =>
          entry.language === "typescript" && entry.skipped === undefined,
      ),
    ).toBe(true);
    expect(entries.map((entry) => entry.symbols[0]!.name)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("an injected loader is invoked once per distinct language across multiple files, not once per file", async () => {
    let loadCalls = 0;
    const stubLanguage = { stub: true } as never;
    const countingLoader: LoadRepoMapLanguageFn = async () => {
      loadCalls += 1;
      return stubLanguage;
    };
    // The stub language will make parser.setLanguage/parse throw, which is fine -- this test only cares that
    // loadLanguage itself was called exactly once per distinct language name, not about parse success.
    await buildRepoMap(
      [
        { path: "a.ts", sourceText: "" },
        { path: "b.ts", sourceText: "" },
        { path: "c.js", sourceText: "" },
      ],
      { loadLanguage: countingLoader },
    );
    expect(loadCalls).toBe(2); // one for "typescript" (a.ts, b.ts), one for "javascript" (c.js)
  });
});

describe("renderRepoMap (#4280)", () => {
  const normalEntry: RepoMapFileEntry = {
    path: "src/widget.ts",
    language: "typescript",
    symbols: [
      {
        kind: "function",
        name: "add",
        signature: "export function add() {",
        line: 1,
      },
    ],
  };
  const skippedEntry: RepoMapFileEntry = {
    path: "README.md",
    language: null,
    symbols: [],
    skipped: "unsupported_language",
  };
  const emptyEntry: RepoMapFileEntry = {
    path: "src/empty.ts",
    language: "typescript",
    symbols: [],
  };

  it("renders one line per symbol plus a header line per file", () => {
    const output = renderRepoMap([normalEntry]);
    expect(output).toBe(
      "src/widget.ts:\n  function add (line 1): export function add() {",
    );
  });

  it("renders every symbol of a multi-symbol file, not just the first", () => {
    const multiSymbolEntry: RepoMapFileEntry = {
      path: "src/multi.ts",
      language: "typescript",
      symbols: [
        { kind: "function", name: "a", signature: "function a() {", line: 1 },
        { kind: "function", name: "b", signature: "function b() {", line: 3 },
      ],
    };
    const output = renderRepoMap([multiSymbolEntry]);
    expect(output).toBe(
      "src/multi.ts:\n  function a (line 1): function a() {\n  function b (line 3): function b() {",
    );
  });

  it("notes a skipped file with its skip reason", () => {
    expect(renderRepoMap([skippedEntry])).toBe(
      "README.md: (skipped: unsupported_language)",
    );
  });

  it("notes a file with no symbols", () => {
    expect(renderRepoMap([emptyEntry])).toBe("src/empty.ts: (no symbols)");
  });

  it("returns an empty string for zero entries", () => {
    expect(renderRepoMap([])).toBe("");
  });

  it("truncates once the char budget is exceeded and appends a truncation marker", () => {
    const manyEntries: RepoMapFileEntry[] = Array.from(
      { length: 50 },
      (_, i) => ({
        path: `src/file${i}.ts`,
        language: "typescript",
        symbols: [
          {
            kind: "function",
            name: `fn${i}`,
            signature: `export function fn${i}() {`,
            line: 1,
          },
        ],
      }),
    );
    const output = renderRepoMap(manyEntries, 200);
    expect(output.length).toBeLessThanOrEqual(
      200 + "\n… (repo map truncated to fit the output budget)".length,
    );
    expect(
      output.endsWith("… (repo map truncated to fit the output budget)"),
    ).toBe(true);
  });

  it("does not truncate when everything fits comfortably under the budget", () => {
    const output = renderRepoMap([normalEntry], 20_000);
    expect(output).not.toContain("truncated");
  });

  it("truncates on a skipped-entry line when the budget is exceeded there", () => {
    const output = renderRepoMap([skippedEntry, normalEntry], 5);
    expect(output).toBe("… (repo map truncated to fit the output budget)");
  });

  it("truncates on a no-symbols-entry line when the budget is exceeded there", () => {
    const output = renderRepoMap([emptyEntry, normalEntry], 5);
    expect(output).toBe("… (repo map truncated to fit the output budget)");
  });

  it("truncates on a file's header line (before any of its symbols) when the budget is exceeded there", () => {
    const output = renderRepoMap([normalEntry], 5);
    expect(output).toBe("… (repo map truncated to fit the output budget)");
  });

  it("truncates partway through a multi-symbol file's symbol list, keeping the symbols that already fit", () => {
    const multiSymbolEntry: RepoMapFileEntry = {
      path: "src/multi.ts",
      language: "typescript",
      symbols: [
        { kind: "function", name: "a", signature: "function a() {", line: 1 },
        { kind: "function", name: "b", signature: "function b() {", line: 3 },
      ],
    };
    const headerAndFirstSymbol =
      "src/multi.ts:\n  function a (line 1): function a() {";
    const output = renderRepoMap(
      [multiSymbolEntry],
      headerAndFirstSymbol.length,
    );
    expect(output).toBe(
      `${headerAndFirstSymbol}\n… (repo map truncated to fit the output budget)`,
    );
  });
});

describe("extractRepoMapSymbols default maxSignatureChars (#4280)", () => {
  it("uses a 120-char default when not passed explicitly by buildRepoMap's caller", async () => {
    const shortSource = "function shortFn(a) {}";
    const [entry] = await buildRepoMap([
      { path: "src/short.js", sourceText: shortSource },
    ]);
    expect(entry!.symbols[0]!.signature).toBe(shortSource);
  });
});
