// Caller-impact analyzer (#1509, part of #1499). A no-checkout headless reviewer sees only the diff, so it cannot
// tell that a PR REMOVES (or renames away) an exported symbol that OTHER, UNCHANGED files in the same repo still
// IMPORT — a hidden cross-file compile/runtime break. This fills that gap: it parses exported top-level
// declarations dropped on removed (`-`) diff lines of changed NON-entrypoint source files, resolves the symbol's
// callers on the repo's default branch via repo-scoped GitHub Code Search, keeps only files the PR did NOT touch,
// then CONFIRMS each candidate genuinely IMPORTS the symbol (a real named / default / namespace import from an
// INTERNAL module path — never a bare-text hit in a comment, a property access, or a same-named import from a
// third-party package) by fetching the file at headSha. A symbol re-added anywhere in the PR (an in-place edit,
// a move, or a re-export) is never flagged. Reports the removed symbol + the unchanged caller file paths only —
// never source.
//
// DISTINCT from the two already-shipped export analyzers, by design:
//  - api-break (#1510): removed exports from a package PUBLIC ENTRYPOINT (barrel) — a DOWNSTREAM/external break;
//    deterministic, no network, no caller resolution. Caller-impact owns the NON-entrypoint (internal) files and
//    resolves the actual IN-REPO callers over the network.
//  - unused-export (#2025): a newly ADDED export with NO callers (dead-on-arrival). Caller-impact is the inverse:
//    a REMOVED export that STILL HAS callers.
//
// Fail-closed: a finding requires POSITIVE, verified evidence of a surviving caller. A missing token/headSha, an
// invalid repo slug, a failed / rate-limited / incomplete Code Search, a malformed response, an unreadable
// candidate file, or an aborted signal all resolve to NO finding for that symbol (never a fabricated one) — an
// error in the search or fetch is NEVER surfaced as a caller. Bounded symbol, search, and file-fetch caps.
import type {
  AnalyzerDiagnostics,
  CallerImpactFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { exportedNames, isPublicEntrypoint } from "./api-break.js";
import { isTestPath } from "./test-ratio.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SYMBOLS = 6; // removed symbols searched per PR (Code Search rate budget)
const MAX_SEARCHES = 6; // bounded Code Search queries per PR
const MAX_FILE_FETCHES = 12; // bounded candidate-caller content fetches per PR
const MAX_CALLERS_PER_FINDING = 5; // caller paths listed per finding (keeps the brief bounded)
const MAX_FINDINGS = 25;
const MIN_SYMBOL_LEN = 3; // skip 1-2 char names — too generic to search reliably
const MAX_FETCH_BYTES = 1_000_000;
const MAX_SEARCH_JSON_BYTES = 256 * 1024;
const SEARCH_PER_PAGE = 50;

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const SKIP_RE = /(?:\.d\.ts$|\.min\.|(?:^|\/)(?:dist|build|vendor|node_modules)\/)/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface CodeSearchItem {
  path?: string;
}

interface CodeSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: CodeSearchItem[];
}

interface RemovedExport {
  file: string;
  symbol: string;
  line: number;
}

function githubHeaders(token: string, raw = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&");
}

/** A repo-relative source path caller-impact will scan: a real TS/JS source ext, not a declaration/min/build
 *  artifact, not a test file. Mirrors the sibling unused-export analyzer's scope. Pure. */
export function isScannablePath(path: string): boolean {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return Boolean(ext && SOURCE_EXTS.has(ext) && !SKIP_RE.test(path) && !isTestPath(path));
}

/** True when `modulePath` is an INTERNAL (in-repo) import specifier — a relative path or a common repo path alias
 *  (`@/…`, `~/…`, `#…`) — as opposed to a bare npm/scoped-package or `node:` builtin. Restricting caller
 *  confirmation to internal imports is what rejects a coincidental same-named import from a third-party package.
 *  Pure. */
export function isInternalModulePath(modulePath: string): boolean {
  return /^(?:\.\.?(?:\/|$)|@\/|~\/|#)/.test(modulePath);
}

/** True when an import/re-export statement `body` (the text between the `import`/`export` keyword and its `from`)
 *  BINDS `symbol` — a named specifier `{ symbol }` / `{ symbol as x }` (imported name compared, so an alias still
 *  matches), a default binding `symbol`, or a namespace `* as symbol`. Pure. */
export function importBindsSymbol(body: string, symbol: string): boolean {
  const brace = /\{([^{}]*)\}/.exec(body);
  if (brace) {
    for (const raw of brace[1]!.split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      if (!spec) continue;
      const importedName = spec.split(/\s+as\s+/)[0]!.trim();
      if (importedName === symbol) return true;
    }
  }
  const beforeBrace = body.replace(/\{[^{}]*\}/g, "").replace(/^\s*type\s+/, "");
  for (const raw of beforeBrace.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(tok);
    if (ns) {
      if (ns[1] === symbol) return true;
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(tok) && tok === symbol) return true;
  }
  return false;
}

/** True when `source` genuinely IMPORTS `symbol` from an INTERNAL module — the strong signal that this unchanged
 *  file is a real caller a removal breaks, versus a coincidental text hit (comment, property access, or a
 *  same-named import from a third-party package). Conservative by design: a caller reaching the symbol only
 *  through a barrel re-export, a namespace member access, or a bare package path is not matched — a false
 *  NEGATIVE only suppresses a finding, which is always fail-safe. Pure. */
const MAX_IMPORT_STATEMENT_CHARS = 8192;

function isStatementBoundary(source: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0) {
    const prev = source.charCodeAt(cursor);
    if (prev !== 9 && prev !== 32) return prev === 10 || prev === 59; // newline or ;
    cursor -= 1;
  }
  return true;
}

function findStatementEnd(source: string, start: number): number {
  const limit = Math.min(source.length, start + MAX_IMPORT_STATEMENT_CHARS);
  let braceDepth = 0;
  for (let index = start; index < limit; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 123) braceDepth += 1; // {
    else if (code === 125 && braceDepth > 0) braceDepth -= 1; // }
    else if (code === 59 || (code === 10 && braceDepth === 0)) return index; // ; or statement-ending newline
  }
  return limit;
}

function parseImportFromStatement(statement: string): { body: string; modulePath: string } | null {
  const from = /\bfrom[ \t]*(['"])([^'"]+)\1/.exec(statement);
  if (!from?.index) return null;
  const modulePath = from[2] ?? "";
  return { body: statement.slice(0, from.index), modulePath };
}

export function fileImportsSymbol(source: string, symbol: string): boolean {
  if (!source.includes(symbol)) return false;
  for (const keyword of ["import", "export"] as const) {
    let cursor = 0;
    while (cursor < source.length) {
      const found = source.indexOf(keyword, cursor);
      if (found === -1) break;
      cursor = found + keyword.length;
      const after = source.charCodeAt(cursor);
      if (!isStatementBoundary(source, found) || !/\s/.test(String.fromCharCode(after))) continue;
      const parsed = parseImportFromStatement(source.slice(cursor, findStatementEnd(source, cursor)));
      if (!parsed || !isInternalModulePath(parsed.modulePath)) continue;
      if (importBindsSymbol(parsed.body, symbol)) return true;
    }
  }
  return false;
}

/** Exported symbols DROPPED on removed (`-`) lines of changed NON-entrypoint source files, keyed to their pre-PR
 *  (old-file) line, EXCLUDING any name re-exported on an added (`+`) line ANYWHERE in the PR (an in-place edit,
 *  move, or re-export re-adds the public name, so callers are not broken). The old-file line counter advances
 *  over removed + context lines (never added lines), mirroring api-break. Deterministic and pure. */
export function collectRemovedExports(
  files: NonNullable<EnrichRequest["files"]>,
): RemovedExport[] {
  const added = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    for (const raw of file.patch.split("\n")) {
      if (raw.startsWith("+") && !raw.startsWith("+++")) {
        for (const name of exportedNames(raw.slice(1))) added.add(name);
      }
    }
  }

  const removed: RemovedExport[] = [];
  for (const file of files) {
    if (!file.patch || !isScannablePath(file.path) || isPublicEntrypoint(file.path)) continue;
    const seen = new Set<string>();
    let oldLine = 0;
    let inHunk = false;
    for (const raw of file.patch.split("\n")) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        oldLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (raw.startsWith("+")) continue; // added line: does not advance the old-file counter
      if (raw.startsWith("-")) {
        if (raw.startsWith("---")) continue;
        for (const name of exportedNames(raw.slice(1))) {
          if (name === "default" || name.length < MIN_SYMBOL_LEN || seen.has(name)) continue;
          seen.add(name);
          removed.push({ file: file.path, symbol: name, line: oldLine });
        }
        oldLine++;
      } else if (!raw.startsWith("\\")) {
        oldLine++;
      }
    }
  }
  return removed.filter((entry) => !added.has(entry.symbol));
}

/** Unchanged in-repo candidate caller paths from a Code Search response for a removed symbol: scannable source
 *  files that are NOT the declaring file and NOT touched by the PR. Returns `null` when the response is UNUSABLE
 *  (missing, incomplete, or malformed) so the caller SUPPRESSES the finding — a failed search is an explicit
 *  unknown state, never "no callers". An empty array means the search succeeded but found no external caller. */
export function candidateCallerPaths(
  response: CodeSearchResponse | null,
  declaringFile: string,
  changedPaths: ReadonlySet<string>,
): string[] | null {
  if (!response || response.incomplete_results) return null;
  if (!Array.isArray(response.items)) return null;
  const out: string[] = [];
  for (const item of response.items) {
    const path = item?.path;
    if (typeof path !== "string" || !path) continue;
    if (path === declaringFile || changedPaths.has(path) || !isScannablePath(path)) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

async function readBoundedText(resp: Response, signal?: AbortSignal): Promise<string | null> {
  const length = Number(resp.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_FETCH_BYTES) return null;
  if (!resp.body) return null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      if (signal?.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FETCH_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchFileAtHead(
  owner: string,
  repo: string,
  path: string,
  headSha: string,
  token: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const resp = await fetchImpl(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(headSha)}`,
      { headers: githubHeaders(token, true), signal },
    );
    if (!resp.ok) return null;
    return await readBoundedText(resp, signal);
  } catch {
    return null;
  }
}

async function searchSymbolReferences(
  owner: string,
  repo: string,
  symbol: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<CodeSearchResponse | null> {
  const q = `"${symbol}" repo:${owner}/${repo}`;
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=${SEARCH_PER_PAGE}`;
  const fetchOptions = {
    endpointCategory: "github-code-search-callers",
    headers: githubHeaders(token),
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "caller-impact",
    subcall: "code-search",
    maxBytes: MAX_SEARCH_JSON_BYTES,
    maxCallsPerCategory: MAX_SEARCHES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CodeSearchResponse>(url, fetchOptions)
    : await boundedFetchJson<CodeSearchResponse>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint: flag exported symbols the PR REMOVES from an internal source file that unchanged in-repo
 *  files still import (a hidden cross-file break). Fail-safe — returns [] on missing token/headSha, invalid slug,
 *  no removed exports, or when no caller can be POSITIVELY confirmed; every search/fetch error degrades to no
 *  finding. Bounded by symbol, search, file-fetch, caller, and finding caps. */
export async function scanCallerImpact(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CallerImpactFinding[]> {
  if (options.signal?.aborted) return [];
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const removed = collectRemovedExports(files).slice(0, MAX_SYMBOLS);
  if (!removed.length) return [];

  const changedPaths = new Set(files.map((file) => file.path));

  const fileCache = new Map<string, string | null>();
  let fileFetches = 0;
  const loadFile = async (path: string): Promise<string | null> => {
    if (fileCache.has(path)) return fileCache.get(path) ?? null;
    if (fileFetches >= MAX_FILE_FETCHES) {
      fileCache.set(path, null);
      return null;
    }
    fileFetches += 1;
    const content = await fetchFileAtHead(owner, repo, path, headSha, githubToken, fetchFn, options.signal);
    fileCache.set(path, content);
    return content;
  };

  const findings: CallerImpactFinding[] = [];
  let searches = 0;
  for (const candidate of removed) {
    if (options.signal?.aborted) break;
    if (searches >= MAX_SEARCHES) break;

    let response: CodeSearchResponse | null = null;
    try {
      response = await searchSymbolReferences(owner, repo, candidate.symbol, githubToken, fetchFn, options);
    } catch {
      response = null;
    }
    searches += 1;

    // A `null` result is an EXPLICIT unknown (search failed / rate-limited / malformed / incomplete); an empty
    // list is a successful "no external caller". Both suppress the finding — an error is never a caller.
    const candidatePaths = candidateCallerPaths(response, candidate.file, changedPaths);
    if (candidatePaths === null || candidatePaths.length === 0) continue;

    const callers: string[] = [];
    for (const path of candidatePaths) {
      if (options.signal?.aborted) break;
      if (callers.length >= MAX_CALLERS_PER_FINDING) break;
      const content = await loadFile(path);
      if (content === null) continue; // unreadable candidate → cannot confirm → skip (fail-safe)
      if (fileImportsSymbol(content, candidate.symbol)) callers.push(path);
    }

    // Emit ONLY on a positively-verified surviving caller. Zero confirmed callers ⇒ no finding.
    if (!callers.length) continue;
    findings.push({
      file: candidate.file,
      line: candidate.line,
      symbol: candidate.symbol,
      callers,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}
