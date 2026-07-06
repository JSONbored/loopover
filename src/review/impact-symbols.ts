// Deterministic changed-symbol extraction (#2182, input slice of #1971's impact map). Pure: given the PR's
// changed files + unified-diff patches, pull the top-level EXPORTED symbol names (function/class/const/type)
// touched by the diff — no AI, no RAG query, no rendering. This is only the INPUT the impact-map computation
// (#2183) consumes; it makes no judgment about callers or blast radius.
//
// Deliberately a regex extractor, not a parser: the codebase already prefers this trade-off for RAG chunking
// (`BOUNDARY_RE` in src/review/rag.ts) — lightweight, no new deps, imperfect but good enough to name the
// symbols a diff touches. Reuses that same `RagBoundary` vocabulary ("function" | "class" | "export") so a
// caller correlating extracted symbols against RAG chunk metadata sees the same three kinds. Fail-safe: any
// unparseable/empty patch yields an empty symbol list for that file, never throws.

import type { RagBoundary } from "./rag";

export type ImpactSymbolChange = {
  /** The bare symbol name (e.g. "computeImpactMap"), never the surrounding declaration syntax. */
  name: string;
  /** How the symbol reads syntactically — mirrors RagBoundary so it correlates with RAG chunk metadata. */
  kind: RagBoundary;
};

export type FileChangedSymbols = {
  path: string;
  symbols: string[];
};

/** The subset of a PR file record this extractor reads (path + optional unified-diff patch text). */
export type ImpactSymbolFile = { path: string; patch?: string | undefined };

const JS_TS_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

// Matches an EXPORTED top-level declaration and captures its name. Only `export`-prefixed forms are kept —
// changed-symbol extraction cares about the PUBLIC surface a caller elsewhere in the repo might depend on,
// not every local helper. `export default function foo` / `export default class Foo` are also matched (the
// name is still useful context even though the import site may not use it). Deliberately narrower than
// rag.ts's BOUNDARY_RE (which also matches un-exported declarations, since RAG chunking cares about ANY
// logical boundary, not just the public API).
const EXPORTED_DECLARATION_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+([\w$]+)|class\s+([\w$]+)|(?:const|let|var)\s+([\w$]+)|interface\s+([\w$]+)|type\s+([\w$]+)|enum\s+([\w$]+))/;

function boundaryKindForMatch(m: RegExpMatchArray): RagBoundary {
  if (m[2] !== undefined) return "class"; // class NAME
  if (m[1] !== undefined) return "function"; // function NAME
  return "export"; // const/let/var/interface/type/enum
}

/**
 * Extract exported top-level symbol names ADDED or MODIFIED by a single unified-diff patch. Only lines added
 * by this diff hunk (`+`, not `+++`) are scanned — a symbol only touched by a REMOVAL (a `-` line, i.e. the
 * symbol was deleted entirely) still surfaces here, since a deleted export is exactly the kind of change a
 * caller elsewhere in the repo needs to know about; we scan removed-name lines too via the same regex applied
 * to `-` lines, unioned with the added set. Non-JS/TS files, and files with no patch, yield no symbols — this
 * is a bounded, language-aware-but-not-language-complete first cut (see module doc).
 */
export function extractSymbolsFromPatch(path: string, patch: string | undefined): ImpactSymbolChange[] {
  if (!patch || !JS_TS_RE.test(path)) return [];
  const seen = new Set<string>();
  const out: ImpactSymbolChange[] = [];
  for (const rawLine of patch.split("\n")) {
    // Only diff content lines carry a real declaration; hunk headers / file headers never do.
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (!rawLine.startsWith("+") && !rawLine.startsWith("-")) continue;
    const line = rawLine.slice(1).trimStart();
    const m = line.match(EXPORTED_DECLARATION_RE);
    if (!m) continue;
    // `m` matched EXPORTED_DECLARATION_RE, whose every alternative captures its symbol name in one of these
    // six groups, so at least one is always defined here (noUncheckedIndexedAccess fallback, mirrors the
    // same idiom in rag.ts's bm25Scores) — the `undefined` leg of this chain is unreachable.
    /* v8 ignore next */
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "";
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, kind: boundaryKindForMatch(m) });
  }
  return out;
}

/**
 * Extract changed exported symbols for every file in a PR's changed-file list. Fail-safe: a file whose patch
 * is missing/unparseable simply contributes an empty `symbols` array (never throws, never drops the file
 * entry) so downstream impact-map computation (#2183) can still see which files changed even with no symbol
 * signal. Files with zero extracted symbols are still returned (not filtered out) so the caller's file count
 * stays accurate; callers that only want files WITH symbols should filter on `symbols.length > 0`.
 */
export function extractChangedSymbols(files: ImpactSymbolFile[]): FileChangedSymbols[] {
  return files.map((file) => {
    try {
      const symbols = extractSymbolsFromPatch(file.path, file.patch).map((s) => s.name);
      return { path: file.path, symbols };
      // Defense in depth: extractSymbolsFromPatch is pure regex/string work and should never throw, but this
      // extractor must NEVER be the reason a review pass fails, so degrade to "no symbols for this file"
      // rather than letting a single malformed patch fail the whole PR's symbol extraction.
      /* v8 ignore start */
    } catch {
      return { path: file.path, symbols: [] };
    }
    /* v8 ignore stop */
  });
}
