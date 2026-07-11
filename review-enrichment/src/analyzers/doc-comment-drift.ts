// Doc-comment-vs-signature drift analyzer (#1519). Flags a JSDoc/TSDoc `@param` tag that names a parameter the PR
// REMOVED or RENAMED while leaving the doc stale. It fetches the full changed file at headSha (one authed contents
// fetch), reverse-applies the patch to reconstruct the pre-PR file, and compares each function's OLD parameter set
// against its NEW one: a `@param` is drift only when it was a real parameter before and is gone now. This makes a
// non-parameter signature edit (return type, name, modifier, parameter type) over PRE-EXISTING stale docs a
// non-finding. Deliberately conservative: only NAMED `function` declarations whose parameters are confidently
// enumerable (any destructuring / non-identifier param → skip the function). Reports symbol + stale params + line.
import type { AnalyzerDiagnostics, EnrichRequest, DocCommentDriftFinding } from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchText } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { reconstructOldContent } from "./reconstruct-old-content.js";

const GITHUB_API = "https://api.github.com";
const MAX_FILES = 20;
const MAX_FINDINGS = 50;
const MAX_SIGNATURE_LINES = 40;
const MAX_FETCH_BYTES = 1_000_000;
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP_RE = /(?:\.d\.ts$|\.min\.|\.test\.|\.spec\.|__tests__\/|(?:^|\/)tests?\/)/;
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
// Matches a named `function` declaration up to its parameter `(`. A single, non-nested generic clause is allowed;
// a nested-generic declaration (e.g. `function f<T extends Record<string, string>>(x)`) simply does not match and
// the function is skipped — a deliberate recall/precision trade-off, never a false positive.
const FUNC_DECL_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchText">;
  diagnostics?: AnalyzerDiagnostics;
}

/** Fetch a changed file's raw content at `headSha` through the shared bounded-text helper (#4759) — with the
 *  analysis context's caching/metering when supplied, mirroring `duplication-delta.ts`'s own `fetchFileAtHead`.
 *  Returns null on any non-OK / oversized / network outcome so the caller fails safe. */
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
    phase: "docCommentDrift",
    subcall: "github-contents",
    maxBytes: MAX_FETCH_BYTES,
    maxCallsPerCategory: MAX_FILES,
  };
  const response = options.analysis
    ? await options.analysis.fetchText(url, fetchOptions)
    : await boundedFetchText(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Map every named `function NAME` declaration in `content` to its enumerable parameter-name set. A function whose
 *  parameters aren't confidently enumerable is omitted; a name DECLARED MORE THAN ONCE (overload/duplicate) is
 *  excluded entirely, so a lookup can never return a sibling declaration's parameters. Used to compare OLD vs NEW. */
export function extractFunctionParams(content: string): Map<string, Set<string>> {
  const lines = content.split("\n");
  const byName = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const decl = FUNC_DECL_RE.exec(lines[i]!);
    if (!decl) continue;
    const name = decl[1]!;
    if (seen.has(name)) {
      byName.delete(name); // a second declaration of this name → ambiguous, exclude it
      continue;
    }
    seen.add(name);
    const params = extractParamSource(lines, i, decl[0].length - 1);
    if (!params) continue;
    const names = parseFunctionParams(params.src);
    if (names) byName.set(name, new Set(names));
  }
  return byName;
}

/** Top-level `@param` identifier names from a JSDoc block. Only real TAG LINES are read — a line whose content
 *  (after an optional `*` gutter) begins with `@param` — so a `@param` token sitting inside prose or an `@example`
 *  body never fabricates a documented parameter. The type group tolerates one level of brace nesting
 *  (`@param {{x: string}} opts`). Nested tags (`@param obj.prop`) reference an existing param and are ignored. Pure. */
export function parseDocParams(jsdoc: string): string[] {
  const names: string[] = [];
  // `@param` must begin the line's content after an optional `/**` opener (single-line block) or `*` gutter, so a
  // single-line `/** @param x */` is read while a `@param` token buried in prose or an `@example` body is not.
  const tag = /^\s*(?:\/\*\*+\s*)?\*?\s*@param\s+(?:\{(?:[^{}]|\{[^{}]*\})*\}\s*)?\[?\s*([A-Za-z_$][\w$]*)(\.[\w$]+)?/;
  for (const line of jsdoc.split("\n")) {
    const match = tag.exec(line);
    if (match && !match[2]) names.push(match[1]!);
  }
  return names;
}

/** If `src[open]` is `<` opening a balanced generic argument list, return the index of its matching `>`; otherwise
 *  −1 (a comparison operator). Tracks nested `<…>` and skips string literals; it does NOT reject `{`/`=>`/etc.
 *  because TS type arguments legitimately contain object types (`Result<string, { x: number }>`) and function
 *  types (`Map<K, (v: V) => void>`). Generic vs comparison is decided by the char after the matching `>`: a
 *  comparison's `>` is followed by an operand (digit/identifier/string — `removed>0`); a generic close is followed
 *  by a type terminator (`,` `)` `(` `[` `>` `|` `&` whitespace or end). */
function matchAngle(src: string, open: number, cache: Map<number, number>): number {
  const cached = cache.get(open);
  if (cached !== undefined) return cached;
  const opens: number[] = [];
  let angle = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "<") {
      if (src[i + 1] === "=") i += 1; // `<=` is a comparison operator, not a generic open
      else {
        angle += 1;
        opens.push(i);
      }
    } else if (ch === ">" && src[i - 1] !== "=") {
      // (a `=>` arrow inside a function type — e.g. `Map<K, (v: V) => void>` — is not an angle close.)
      if (src[i + 1] === "=") {
        cache.set(open, -1);
        return -1; // `>=` is a comparison operator, never a generic close
      }
      angle -= 1;
      opens.pop();
      if (angle === 0) {
        let j = i + 1;
        while (j < src.length && /\s/.test(src[j]!)) j += 1; // the next NON-whitespace token decides
        const next = src[j];
        const close = next !== undefined && /[\w$"'`]/.test(next) ? -1 : i;
        cache.set(open, close);
        return close;
      }
    }
  }
  // An unmatched generic-like opener cannot close when probed again from the same point. Remember every still-open
  // candidate from this scan so repeated attacker-controlled `x<` tokens do not rescan the same suffixes.
  for (const pending of opens) cache.set(pending, -1);
  return -1;
}

/** Split a parameter-list source on top-level commas, tracking ()/{}/[] depth, balanced generic `<…>` regions, and
 *  string literals. A `<` that abuts an identifier (`Map<`, `makeMap<`) is probed by `matchAngle`, which accepts it
 *  as a generic only when the closing `>` is followed by a type terminator — covering type annotations
 *  (`a: Map<K, V>`), generic calls/constructors (`makeMap<K, V>()`, `new Map<K, V>()`), and casts (`x as Map<K, V>`)
 *  — and rejects comparison operators (`x < y`, `z > q`). Returns null only if the unambiguous brackets never balance. */
function splitParams(src: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | null = null;
  const angleCache = new Map<number, number>();
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === "<" && i > 0 && /[A-Za-z0-9_$]/.test(src[i - 1]!)) {
      const close = matchAngle(src, i, angleCache);
      if (close !== -1) i = close; // skip the whole generic argument list, including its commas
    } else if (ch === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(src.slice(start));
  return parts;
}

/** Parameter names of a function from its parenthesised source, or null when not confidently enumerable. Each
 *  comma-separated segment (commas inside generics/brackets/strings don't split) yields its leading identifier
 *  after an optional rest marker. A destructured segment (`{…}`/`[…]`) or a segment without a leading identifier
 *  makes the set ambiguous → null. Generic-typed and defaulted params (`cache = new Map<K, V>()`) enumerate
 *  cleanly because the generic's comma no longer splits the list. Pure. */
export function parseFunctionParams(paramSrc: string): string[] | null {
  const trimmed = paramSrc.trim();
  if (!trimmed) return [];
  const parts = splitParams(trimmed);
  if (!parts) return null; // unbalanced brackets — not confidently enumerable
  const names: string[] = [];
  for (const raw of parts) {
    const part = raw.trim().replace(/^\.\.\.\s*/, ""); // drop a rest marker
    if (!part) continue;
    if (part.startsWith("{") || part.startsWith("[")) return null; // destructured pattern — names not enumerable
    const name = /^([A-Za-z_$][\w$]*)/.exec(part);
    if (!name) return null; // not a plain identifier — ambiguous
    const id = name[1]!;
    // After the name a real parameter has only a type (`:`), an optional marker (`?`), a default (`=`), or nothing.
    const rest = part.slice(id.length).trimStart();
    if (rest && !/^[:?=]/.test(rest)) return null;
    if (id === "this") continue; // a TS `this` pseudo-parameter is not a real argument
    names.push(id);
  }
  return names;
}

/** From the `(` at `lines[startLine][openIdx]`, return the inner parameter source (balanced, possibly multi-line)
 *  and the line index of the matching `)`. Null if unbalanced within the line budget. */
function extractParamSource(
  lines: string[],
  startLine: number,
  openIdx: number,
): { src: string; endLine: number } | null {
  let depth = 0;
  let src = "";
  let quote: string | null = null;
  const limit = Math.min(lines.length, startLine + MAX_SIGNATURE_LINES);
  for (let li = startLine; li < limit; li++) {
    const line = lines[li]!;
    for (let k = li === startLine ? openIdx : 0; k < line.length; k++) {
      const ch = line[k]!;
      if (quote) {
        if (ch === quote && line[k - 1] !== "\\") quote = null;
        src += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        src += ch;
        continue;
      }
      if (ch === "(") {
        depth += 1;
        if (depth === 1) continue; // drop the outer opening paren
      } else if (ch === ")") {
        depth -= 1;
        if (depth === 0) return { src, endLine: li };
      }
      src += ch;
    }
    src += "\n";
  }
  return null;
}

/** The JSDoc block directly above `lines[funcLine]` (only blank lines may separate them), or null. The adjacent
 *  block must be a real `/**` JSDoc: we take the contiguous block ending at the nearest `*/` and walk up to ITS
 *  opener (the first `/*` — block comments don't nest). A plain `/* … *​/` block returns null, so an unrelated
 *  earlier JSDoc above a plain comment is never mis-attached. */
function precedingJsdoc(lines: string[], funcLine: number): string | null {
  let end = funcLine - 1;
  while (end >= 0 && lines[end]!.trim() === "") end -= 1;
  if (end < 0 || !lines[end]!.trimEnd().endsWith("*/")) return null;
  let start = end;
  while (start >= 0 && !lines[start]!.includes("/*")) start -= 1;
  if (start < 0 || !lines[start]!.trimStart().startsWith("/**")) return null; // opener must be a real JSDoc block
  return lines.slice(start, end + 1).join("\n");
}

/** Pure: find functions whose preceding JSDoc documents a `@param` that was a REAL parameter before this PR
 *  (`oldParamsByName`, from the reconstructed old file) but is absent from the CURRENT signature — i.e. the PR
 *  removed or renamed that parameter and left the doc stale. Gating on the name having been an actual OLD parameter
 *  (rather than merely a token the patch touched) is what keeps a non-parameter signature edit — a return type,
 *  name, modifier, or parameter type — over pre-existing stale docs from being reported as PR-introduced drift.
 *  Conservative: only named `function` declarations with confidently-enumerable params and an adjacent `/**` JSDoc. */
export function findDocCommentDrift(
  content: string,
  oldParamsByName: Map<string, Set<string>>,
): Array<{ symbol: string; line: number; staleParams: string[] }> {
  const lines = content.split("\n");
  // Count declarations per name so an overload/duplicate (which can't be matched 1:1 to an old signature) is skipped.
  const nameCounts = new Map<string, number>();
  for (const line of lines) {
    const decl = FUNC_DECL_RE.exec(line);
    if (decl) nameCounts.set(decl[1]!, (nameCounts.get(decl[1]!) ?? 0) + 1);
  }
  const findings: Array<{ symbol: string; line: number; staleParams: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    const decl = FUNC_DECL_RE.exec(lines[i]!);
    if (!decl) continue;
    if ((nameCounts.get(decl[1]!) ?? 0) > 1) continue; // duplicate-named declaration — ambiguous, skip
    const params = extractParamSource(lines, i, decl[0].length - 1);
    if (!params) continue;

    const actual = parseFunctionParams(params.src);
    if (actual === null) continue; // ambiguous current signature — skip
    const jsdoc = precedingJsdoc(lines, i);
    if (!jsdoc) continue;

    const oldParams = oldParamsByName.get(decl[1]!);
    if (!oldParams) continue; // no confidently-enumerable old signature for this name → nothing was removed

    const declared = new Set(actual);
    // Stale drift = a documented param that WAS a real parameter before the PR and is gone now (removed/renamed).
    const stale = [
      ...new Set(parseDocParams(jsdoc).filter((name) => oldParams.has(name) && !declared.has(name))),
    ];
    if (stale.length) findings.push({ symbol: decl[1]!, line: i + 1, staleParams: stale });
  }
  return findings;
}

/** Analyzer entrypoint: fetch each changed source file at headSha, report doc-vs-signature drift. Fail-safe. */
export async function scanDocCommentDrift(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DocCommentDriftFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const sources = files
    .filter((file) => file.patch && SOURCE_RE.test(file.path) && !SKIP_RE.test(file.path))
    .slice(0, MAX_FILES);

  const findings: DocCommentDriftFinding[] = [];
  for (const file of sources) {
    if (options.signal?.aborted) break;

    const content = await fetchFileAtHead(owner, repo, file.path, headSha, githubToken, fetchFn, options);
    if (!content) continue;
    if (options.signal?.aborted) break; // an abort during the fetch should suppress this file's findings too

    // Reverse-apply the patch to get the PRE-PR file, then compare each function's OLD vs NEW parameters.
    const oldContent = reconstructOldContent(content, file.patch!);
    if (!oldContent) continue; // couldn't reconstruct the pre-PR file → fail closed, report nothing
    const oldParamsByName = extractFunctionParams(oldContent);
    for (const drift of findDocCommentDrift(content, oldParamsByName)) {
      findings.push({ file: file.path, line: drift.line, symbol: drift.symbol, staleParams: drift.staleParams });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }
  return findings;
}
