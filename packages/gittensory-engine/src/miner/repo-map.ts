// Tree-sitter-based repo map builder (#4280): gives a coding-agent driver (or the acceptance-criteria/prompt-
// packet builders upstream of it) a compact, structural view of a target repository -- function/class/method
// signatures -- without paying the token cost of dumping full file contents into a prompt. Uses `web-tree-sitter`
// (the WASM binding) with prebuilt grammars from `tree-sitter-wasms`, not a native addon: this package also ships
// a Cloudflare Workers deployment target where native Node addons are not an option. This module only ever runs
// in the local miner/CLI process, but the WASM binding keeps that door open and needs no native build step.
//
// Supported today: JavaScript/TypeScript/TSX (this repo's own dominant languages). A file whose extension has no
// mapped grammar is skipped (not crashed on) with `skipped: "unsupported_language"`; a grammar that fails to load
// or a parse that throws is caught the same way, with `skipped: "grammar_unavailable"` -- this module's contract
// is "extract what it safely can," never "block the whole driver invocation."
//
// Known scope limit: only `function`/`class` declarations and expressions, `method_definition`, `interface`, and
// `type` alias nodes are extracted -- an arrow function or class expression bound via a `const foo = ...`
// declarator is not walked up to its binding identifier, so it is either missed (arrow functions aren't matched
// at all yet) or reported as "<anonymous>" (a bare class/function expression). Good enough for a compact outline
// today; resolving binding names is a reasonable follow-up, not attempted here.

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Parser from "web-tree-sitter";

// Lazy, not module-scope: this file is reachable from the Cloudflare Workers bundle (barrel-exported via
// `@jsonbored/gittensory-engine`) even though nothing there ever calls `buildRepoMap`. `import.meta.url` is
// undefined in that bundle's startup-validation context, so an eager `createRequire(import.meta.url)` at
// module scope would crash the Worker's deploy before any request is served. Deferring construction to
// first real use keeps this module import-safe everywhere while still working for its actual CLI callers.
let cachedRequire: NodeJS.Require | null = null;
function requireFromHere(): NodeJS.Require {
  return (cachedRequire ??= createRequire(import.meta.url));
}

export type RepoMapSymbolKind =
  "function" | "class" | "method" | "interface" | "type";

export type RepoMapSymbol = {
  kind: RepoMapSymbolKind;
  name: string;
  signature: string;
  line: number;
};

export type RepoMapSkipReason =
  "unsupported_language" | "grammar_unavailable" | "resource_limit";

export type RepoMapFileEntry = {
  path: string;
  language: string | null;
  symbols: readonly RepoMapSymbol[];
  skipped?: RepoMapSkipReason;
};

export type RepoMapSourceFile = {
  path: string;
  sourceText: string;
};

/** File extension (including the leading dot) -> tree-sitter grammar name in `tree-sitter-wasms`. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
});

const SYMBOL_NODE_KIND: Readonly<Record<string, RepoMapSymbolKind>> =
  Object.freeze({
    function_declaration: "function",
    // `function_expression`/`class` (bare, unnamed) cover `export default function() {}` / `export default class {}`
    // and other expression positions -- these have no `name` field, so `nameOf` reports them as "<anonymous>"
    // rather than skipping them outright.
    function_expression: "function",
    class_declaration: "class",
    class: "class",
    method_definition: "method",
    interface_declaration: "interface",
    type_alias_declaration: "type",
  });

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

/** Pure: map a file path to the grammar name that would parse it, or null if unsupported. */
export function resolveRepoMapLanguage(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

/** Test/injection seam for loading a compiled grammar -- real WASM-file IO lives only in the default
 *  implementation, so a test can inject a failing loader to exercise `grammar_unavailable` without needing an
 *  actually-broken WASM file. */
export type LoadRepoMapLanguageFn = (
  languageName: string,
) => Promise<Parser.Language>;

let parserInitialized: Promise<void> | null = null;

async function defaultLoadRepoMapLanguage(
  languageName: string,
): Promise<Parser.Language> {
  parserInitialized ??= Parser.init();
  await parserInitialized;
  const wasmPath = requireFromHere().resolve(
    `tree-sitter-wasms/out/tree-sitter-${languageName}.wasm`,
  );
  return Parser.Language.load(readFileSync(wasmPath));
}

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_SOURCE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_SOURCE_BYTES = 5_000_000;
const DEFAULT_MAX_AST_NODES = 50_000;
const DEFAULT_MAX_SYMBOLS = 5_000;
const MAX_NAME_CHARS = 200;

function boundedNodeText(
  sourceText: string,
  node: Parser.SyntaxNode,
  maxChars: number,
): string {
  return sourceText.slice(
    node.startIndex,
    Math.min(node.endIndex, node.startIndex + maxChars),
  );
}

/** First line of a symbol node's own text, trimmed and bounded to `maxChars` (with an ellipsis marker when cut),
 *  so one huge one-line minified function can't blow out the rendered output on its own. */
function signatureOf(
  sourceText: string,
  node: Parser.SyntaxNode,
  maxChars: number,
): string {
  const end = Math.min(node.endIndex, node.startIndex + maxChars + 1);
  const newline = sourceText.indexOf("\n", node.startIndex);
  const sliceEnd = newline === -1 || newline > end ? end : newline;
  const firstLine = sourceText.slice(node.startIndex, sliceEnd).trim();
  return node.endIndex - node.startIndex > maxChars &&
    firstLine.length >= maxChars
    ? `${firstLine.slice(0, maxChars)}…`
    : firstLine;
}

function nameOf(sourceText: string, node: Parser.SyntaxNode): string {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return "<anonymous>";
  const name = boundedNodeText(sourceText, nameNode, MAX_NAME_CHARS + 1);
  return name.length > MAX_NAME_CHARS
    ? `${name.slice(0, MAX_NAME_CHARS)}…`
    : name;
}

export type ExtractRepoMapSymbolsOptions = {
  maxSignatureChars?: number | undefined;
  maxAstNodes?: number | undefined;
  maxSymbols?: number | undefined;
};

/** Walk a parsed tree collecting one `RepoMapSymbol` per matched node kind (function/class/method/interface/
 *  type declarations). Pure given an already-parsed tree. Returns `null` when extraction exceeds its work budget. */
export function extractRepoMapSymbols(
  tree: Parser.Tree,
  maxSignatureChars?: number,
): RepoMapSymbol[] | null;
export function extractRepoMapSymbols(
  tree: Parser.Tree,
  sourceText: string,
  options?: ExtractRepoMapSymbolsOptions,
): RepoMapSymbol[] | null;
export function extractRepoMapSymbols(
  tree: Parser.Tree,
  sourceTextOrMaxSignatureChars: string | number = tree.rootNode.text,
  options: ExtractRepoMapSymbolsOptions = {},
): RepoMapSymbol[] | null {
  const sourceText =
    typeof sourceTextOrMaxSignatureChars === "string"
      ? sourceTextOrMaxSignatureChars
      : tree.rootNode.text;
  const maxSignatureChars =
    typeof sourceTextOrMaxSignatureChars === "number"
      ? sourceTextOrMaxSignatureChars
      : (options.maxSignatureChars ?? 120);
  const maxAstNodes = options.maxAstNodes ?? DEFAULT_MAX_AST_NODES;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const symbols: RepoMapSymbol[] = [];
  const stack: Parser.SyntaxNode[] = [tree.rootNode];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop()!;
    visited += 1;
    if (visited > maxAstNodes) return null;
    const kind = SYMBOL_NODE_KIND[node.type];
    if (kind) {
      if (symbols.length >= maxSymbols) return null;
      symbols.push({
        kind,
        name: nameOf(sourceText, node),
        signature: signatureOf(sourceText, node, maxSignatureChars),
        line: node.startPosition.row + 1,
      });
    }
    for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
      stack.push(node.namedChild(index) as Parser.SyntaxNode);
    }
  }
  return symbols;
}

export type BuildRepoMapOptions = {
  loadLanguage?: LoadRepoMapLanguageFn | undefined;
  maxSignatureChars?: number | undefined;
  maxFiles?: number | undefined;
  maxSourceBytes?: number | undefined;
  maxTotalSourceBytes?: number | undefined;
  maxAstNodes?: number | undefined;
  maxSymbols?: number | undefined;
};

/** Build one `RepoMapFileEntry` per source file: unsupported extensions and grammar/parse failures are caught
 *  and reported via `skipped`, never thrown -- see module header. A language's grammar is only loaded once per
 *  call even across many files of the same language. */
export async function buildRepoMap(
  files: readonly RepoMapSourceFile[],
  options: BuildRepoMapOptions = {},
): Promise<RepoMapFileEntry[]> {
  const loadLanguage = options.loadLanguage ?? defaultLoadRepoMapLanguage;
  const maxSignatureChars = options.maxSignatureChars ?? 120;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxTotalSourceBytes =
    options.maxTotalSourceBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES;
  const maxAstNodes = options.maxAstNodes ?? DEFAULT_MAX_AST_NODES;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const languageCache = new Map<string, Parser.Language | null>();

  async function resolveLanguage(
    name: string,
  ): Promise<Parser.Language | null> {
    const cached = languageCache.get(name);
    if (cached !== undefined) return cached;
    try {
      const language = await loadLanguage(name);
      languageCache.set(name, language);
      return language;
    } catch {
      languageCache.set(name, null);
      return null;
    }
  }

  const entries: RepoMapFileEntry[] = [];
  let totalSourceBytes = 0;
  for (const [index, file] of files.entries()) {
    if (index >= maxFiles) {
      entries.push({
        path: file.path,
        language: resolveRepoMapLanguage(file.path),
        symbols: [],
        skipped: "resource_limit",
      });
      continue;
    }
    const languageName = resolveRepoMapLanguage(file.path);
    const sourceBytes = Buffer.byteLength(file.sourceText, "utf8");
    totalSourceBytes += sourceBytes;
    if (
      sourceBytes > maxSourceBytes ||
      totalSourceBytes > maxTotalSourceBytes
    ) {
      entries.push({
        path: file.path,
        language: languageName,
        symbols: [],
        skipped: "resource_limit",
      });
      continue;
    }
    if (!languageName) {
      entries.push({
        path: file.path,
        language: null,
        symbols: [],
        skipped: "unsupported_language",
      });
      continue;
    }
    const language = await resolveLanguage(languageName);
    if (!language) {
      entries.push({
        path: file.path,
        language: languageName,
        symbols: [],
        skipped: "grammar_unavailable",
      });
      continue;
    }
    try {
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(file.sourceText);
      const symbols = extractRepoMapSymbols(tree, file.sourceText, {
        maxSignatureChars,
        maxAstNodes,
        maxSymbols,
      });
      entries.push({
        path: file.path,
        language: languageName,
        symbols: symbols ?? [],
        ...(symbols === null ? { skipped: "resource_limit" as const } : {}),
      });
    } catch {
      entries.push({
        path: file.path,
        language: languageName,
        symbols: [],
        skipped: "grammar_unavailable",
      });
    }
  }
  return entries;
}

/** Render entries into a bounded plain-text outline: one line per symbol (`kind name (line N): signature`),
 *  skipped/empty files noted with a one-line placeholder. Stops once `maxOutputChars` would be exceeded and
 *  appends a truncation marker, so a caller/prompt-builder can tell the map is partial rather than complete. */
export function renderRepoMap(
  entries: readonly RepoMapFileEntry[],
  maxOutputChars = 20_000,
): string {
  const lines: string[] = [];
  let length = 0;
  let truncated = false;

  function pushLine(line: string): boolean {
    const addedLength = length === 0 ? line.length : line.length + 1; // +1 for the joining newline
    if (length + addedLength > maxOutputChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += addedLength;
    return true;
  }

  outer: for (const entry of entries) {
    if (entry.skipped) {
      if (!pushLine(`${entry.path}: (skipped: ${entry.skipped})`)) break outer;
    } else if (entry.symbols.length === 0) {
      if (!pushLine(`${entry.path}: (no symbols)`)) break outer;
    } else {
      if (!pushLine(`${entry.path}:`)) break outer;
      for (const symbol of entry.symbols) {
        if (
          !pushLine(
            `  ${symbol.kind} ${symbol.name} (line ${symbol.line}): ${symbol.signature}`,
          )
        )
          break outer;
      }
    }
  }

  if (truncated) lines.push("… (repo map truncated to fit the output budget)");
  return lines.join("\n");
}
