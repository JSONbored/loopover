// Public-API undocumented-export scan (#2035, part of #1499). Flags exports NEWLY ADDED to a package's public
// entrypoint (an `index.*` barrel) that ship with no adjacent doc comment — undocumented public surface a reviewer
// should notice. It reads added export declarations from the diff, then fetches the changed entrypoint at headSha
// (one authed contents fetch) to confirm, against the FINAL file, that each added export has no preceding
// JSDoc/line comment. Deliberately conservative + fail-safe: only DIRECT `export function|const|let|var|class|
// interface|type|enum NAME` declarations in `index.*` files (re-export lists and `export *` are ignored, since they
// aggregate symbols documented at their definition); a missing token/head-sha, an unresolvable repo slug, or any
// fetch error yields no finding rather than an error.
import type { AnalyzerDiagnostics, EnrichRequest, UndocumentedExportFinding } from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchText } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";

const GITHUB_API = "https://api.github.com";
const MAX_FILES = 10;
const MAX_FINDINGS = 30;
const MAX_FETCH_BYTES = 1_000_000;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// A public entrypoint barrel — an `index.<js/ts>` source file. Declaration (.d.ts), test, and generated output are
// excluded: they are not the hand-authored public surface this scan is about.
const ENTRYPOINT_RE = /(?:^|\/)index\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)(?:dist|build|vendor)\/)/;
// A DIRECT exported declaration and its kind (matched on the line body, without the diff `+`). Anchored at column 1
// so only TOP-LEVEL module exports are considered public surface: an INDENTED `export` (e.g. a member of an
// unexported `namespace Internal { … }`) is intentionally NOT scanned, since it is not a public module export.
const EXPORT_DECL_RE =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\s*\*?|const|let|var|class|interface|type|enum)\s+/;
const IDENT_RE = /^[A-Za-z_$][\w$]*/;
// A `//` comment whose text starts like one of these is a tool/suppression directive, not symbol documentation.
const DIRECTIVE_COMMENT_RE =
  /^(?:eslint-|@ts-|prettier-|biome-|deno-lint-|istanbul\b|c8\b|v8\b|@preserve\b|@license\b|noinspection\b)/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchText">;
  diagnostics?: AnalyzerDiagnostics;
}

/** Split a `const`/`let`/`var` declarator list on TOP-LEVEL commas, tracking ()/{}/[] depth and string literals so a
 *  comma inside an initializer (`f(1, 2)`, `[1, 2]`) does not split, and stopping at the first top-level `;`. Pure. */
function splitTopLevelCommas(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      // The quote closes only when it is NOT escaped: count consecutive preceding backslashes — an EVEN count means
      // the quote is unescaped (a trailing `\\` inside the string doesn't escape the closing quote).
      if (ch === quote) {
        let backslashes = 0;
        for (let k = i - 1; k >= 0 && src[k] === "\\"; k--) backslashes += 1;
        if (backslashes % 2 === 0) quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      parts.push(src.slice(start, i));
      return parts; // the declarator list ends at the statement terminator
    } else if (ch === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/** The exported symbol name(s) a line body declares (no diff `+`), or [] if it is not a direct export declaration.
 *  `function/class/interface/type/enum` declare a single symbol; a `const/let/var` line may declare SEVERAL via a
 *  comma-separated declarator list (`export const a = 1, b = 2`). A declarator whose binding is not a plain
 *  identifier (destructuring `{…}`/`[…]`, or an identifier not followed by `=`/`:`/`!`/`?`/end) is skipped
 *  conservatively, so a comma inside a generic type (`Map<K, V>`) can't fabricate a `V` binding. Pure. */
export function exportedSymbols(lineBody: string): string[] {
  const decl = EXPORT_DECL_RE.exec(lineBody);
  if (!decl) return [];
  const rest = lineBody.slice(decl[0].length);
  if (decl[1] !== "const" && decl[1] !== "let" && decl[1] !== "var") {
    const name = IDENT_RE.exec(rest);
    return name ? [name[0]] : [];
  }
  const symbols: string[] = [];
  for (const part of splitTopLevelCommas(rest)) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) continue; // destructuring — not enumerable
    const name = IDENT_RE.exec(trimmed);
    if (!name) continue;
    const after = trimmed.slice(name[0].length).trimStart();
    if (after === "" || /^[=:!?]/.test(after)) symbols.push(name[0]); // a real binding, not e.g. `V>` from a generic
  }
  return symbols;
}

/** Added export declarations in a unified diff, each exported symbol with its NEW-file line number. Walks hunk
 *  headers to track the new-file cursor; only `+` lines that declare a direct export are collected (`-`/`\` lines
 *  never advance the new cursor, `+++`/`---` headers are ignored). A multi-declarator line yields one entry per
 *  binding, all sharing the same line. Pure. */
export function parseAddedExports(patch: string): Array<{ symbol: string; newLine: number }> {
  const out: Array<{ symbol: string; newLine: number }> = [];
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      // Skip only a real unified-diff file header (`+++ b/path`), not added CONTENT that merely starts with
      // `++` (git renders `++x;` as `+++x;`). The bespoke startsWith("+++") guard dropped such a line and left
      // the new-file cursor un-advanced, mis-numbering (and thus losing) every export after it. Use the shared
      // header predicate the sibling diff analyzers rely on.
      if (!isDiffFileHeaderLine(raw)) {
        for (const symbol of exportedSymbols(raw.slice(1))) out.push({ symbol, newLine });
        newLine += 1;
      }
    } else if (!raw.startsWith("-") && !raw.startsWith("\\")) {
      newLine += 1; // context line advances the new-file cursor
    }
  }
  return out;
}

/** True when the line at `lineIndex` (0-based) has an adjacent DOC comment directly above it: a `//` line comment,
 *  or a block comment whose opener is a real JSDoc `/**` (walked up from its `*​/` terminator). Blank lines and
 *  decorator lines (`@Component()`) in between are skipped. A plain non-doc block (`/* eslint-disable *​/`) and a
 *  code line with a trailing block comment are NOT documentation, so a genuinely undocumented export is still
 *  flagged. Pure. */
export function hasPrecedingDocComment(lines: string[], lineIndex: number): boolean {
  let i = lineIndex - 1;
  while (i >= 0) {
    const trimmed = lines[i]!.trim();
    if (trimmed === "" || trimmed.startsWith("@")) {
      i -= 1;
      continue;
    }
    break;
  }
  if (i < 0) return false;
  const above = lines[i]!.trim();
  // A `//` line comment counts as documentation UNLESS it is a tool/suppression directive (eslint-disable,
  // ts-* pragmas, prettier-ignore, istanbul/c8/v8 ignore, …) — those describe tooling, not the symbol.
  if (above.startsWith("//")) return !DIRECTIVE_COMMENT_RE.test(above.slice(2).trim());
  if (!above.endsWith("*/")) return false; // not a block-comment terminator directly above → undocumented
  // Walk up to the block's opener; only a real JSDoc block (`/**`) is documentation. This also rejects a code line
  // with a trailing comment (`const x = 1; /* c */`) — its opener line starts with code, not `/**`.
  let j = i;
  while (j >= 0 && !lines[j]!.includes("/*")) j -= 1;
  return j >= 0 && lines[j]!.trimStart().startsWith("/**");
}

/** Fetch a changed entrypoint's raw content at `headSha` through the shared bounded-text helper (with the analysis
 *  context's caching/metering when supplied, mirroring `duplication-delta.ts`'s own `fetchFileAtHead`). Returns
 *  null on any non-OK / oversized / network outcome so the caller fails safe. */
async function fetchFileAtHead(
  owner: string,
  repo: string,
  path: string,
  headSha: string,
  token: string,
  fetchFn: typeof fetch,
  options: ScanOptions,
): Promise<string | null> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(headSha)}`;
  const fetchOptions = {
    endpointCategory: "github-contents",
    headers: githubHeaders(token, { raw: true }),
    signal: options.signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "undocumented-export",
    subcall: "github-contents",
    maxBytes: MAX_FETCH_BYTES,
    maxCallsPerCategory: MAX_FILES,
  };
  const response = options.analysis
    ? await options.analysis.fetchText(url, fetchOptions)
    : await boundedFetchText(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint: for each changed `index.*` entrypoint, fetch it at headSha and flag added exports with no
 *  adjacent doc comment. Fail-safe — returns no finding on a missing token/head-sha, bad slug, or fetch error. */
export async function scanUndocumentedExport(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<UndocumentedExportFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  // Require EXACTLY `owner/repo`: a 3+ segment value would otherwise query the wrong repo instead of failing safe.
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  // Parse added exports FIRST (cheap, pure), then spend the MAX_FILES fetch budget only on entrypoints that actually
  // have added exports — so index files with no relevant additions can't consume the budget and hide later ones.
  const candidates: Array<{ file: (typeof files)[number]; added: Array<{ symbol: string; newLine: number }> }> = [];
  for (const file of files) {
    if (!file.patch || !ENTRYPOINT_RE.test(file.path) || SKIP_RE.test(file.path)) continue;
    const added = parseAddedExports(file.patch);
    if (!added.length) continue;
    candidates.push({ file, added });
    if (candidates.length >= MAX_FILES) break;
  }

  const findings: UndocumentedExportFinding[] = [];
  for (const { file, added } of candidates) {
    if (options.signal?.aborted) break;

    const content = await fetchFileAtHead(owner, repo, file.path, headSha, githubToken, fetchFn, options);
    if (!content) continue;
    if (options.signal?.aborted) break; // an abort during the fetch should suppress this file's findings too

    const lines = content.split("\n");
    for (const { symbol, newLine } of added) {
      const idx = newLine - 1;
      const line = lines[idx];
      if (line === undefined) continue;
      // Confirm the export still declares this symbol at that line in the FINAL file (patch/head aligned); a mismatch
      // means the line moved or changed, so fail closed and skip it.
      if (!exportedSymbols(line).includes(symbol)) continue;
      if (hasPrecedingDocComment(lines, idx)) continue;
      findings.push({ file: file.path, line: newLine, symbol });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
