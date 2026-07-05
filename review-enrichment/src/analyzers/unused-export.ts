// Unused-export / dead-on-arrival scan (#2025). Flags exports NEWLY ADDED by the PR that have zero non-declaration
// references anywhere in the repo — net-new public surface with no callers yet. Narrow subset of caller-impact (#1509):
// only added direct exports, not changed/removed symbols. Parses added export declarations from the diff, checks the
// declaring file at headSha for same-file references, then resolves external references via repo-scoped GitHub Code
// Search on the default-branch index (injected fetch). A brand-new PR export is usually absent from that index
// (`total_count: 0`), which is treated as dead-on-arrival once same-file uses are ruled out. Bounded symbol, search,
// and file-fetch caps; fail-safe on missing token/headSha, bad slug, search errors, or incomplete results.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  UnusedExportFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { exportedSymbols, parseAddedExports } from "./undocumented-export.js";
import { isTestPath } from "./test-ratio.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SYMBOLS = 10;
const MAX_SEARCHES = 10;
const MAX_FILE_FETCHES = 10;
const MAX_FINDINGS = 25;
const MIN_SYMBOL_LEN = 3;
const MAX_FETCH_BYTES = 1_000_000;
const MAX_SEARCH_JSON_BYTES = 256 * 1024;

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"]);
const SKIP_RE = /(?:\.d\.ts$|\.min\.|(?:^|\/)(?:dist|build|vendor)\/)/;

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

function isScannablePath(path: string): boolean {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return Boolean(ext && SOURCE_EXTS.has(ext) && !SKIP_RE.test(path) && !isTestPath(path));
}

/** True when `source` references `symbol` on any line other than the export declaration at `declLine` (1-based). */
export function referencesSymbolInSource(
  source: string,
  symbol: string,
  declLine: number,
): boolean {
  const refRe = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(symbol)}(?![A-Za-z0-9_$])`);
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i === declLine - 1) continue;
    if (refRe.test(lines[i]!)) return true;
  }
  return false;
}

/** True when default-branch Code Search shows no external references: zero indexed hits (typical for a brand-new PR
 *  export) or exactly one hit confined to the declaring file. Returns null when the response is unusable. */
export function isDeadOnArrivalFromSearch(
  exportFile: string,
  response: CodeSearchResponse | null,
): boolean | null {
  if (!response || response.incomplete_results) return null;
  const total = response.total_count ?? 0;
  if (total === 0) return true;
  const items = response.items ?? [];
  if (items.some((item) => item.path && item.path !== exportFile)) return false;
  return total === 1;
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
  const url = `${GITHUB_API}/search/code?q=${encodeURIComponent(q)}&per_page=100`;
  const fetchOptions = {
    endpointCategory: "github-code-search",
    headers: githubHeaders(token),
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "unused-export",
    subcall: "code-search",
    maxBytes: MAX_SEARCH_JSON_BYTES,
    maxCallsPerCategory: MAX_SEARCHES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CodeSearchResponse>(url, fetchOptions)
    : await boundedFetchJson<CodeSearchResponse>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint: parse added direct exports from changed source files and flag symbols with no non-declaration
 *  references. Fail-safe — returns no finding on missing token/headSha or search/fetch errors. */
export async function scanUnusedExport(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<UnusedExportFinding[]> {
  const { repoFullName, githubToken, headSha, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const candidates: Array<{ file: string; symbol: string; line: number }> = [];
  for (const file of files) {
    if (!file.patch || !isScannablePath(file.path)) continue;
    for (const { symbol, newLine } of parseAddedExports(file.patch)) {
      if (symbol.length < MIN_SYMBOL_LEN) continue;
      candidates.push({ file: file.path, symbol, line: newLine });
      if (candidates.length >= MAX_SYMBOLS) break;
    }
    if (candidates.length >= MAX_SYMBOLS) break;
  }
  if (!candidates.length) return [];

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

  const findings: UnusedExportFinding[] = [];
  let searches = 0;
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (searches >= MAX_SEARCHES) break;

    const content = await loadFile(candidate.file);
    if (content) {
      const idx = candidate.line - 1;
      const line = content.split("\n")[idx];
      if (line !== undefined && !exportedSymbols(line).includes(candidate.symbol)) continue;
      if (referencesSymbolInSource(content, candidate.symbol, candidate.line)) continue;
    }

    let response: CodeSearchResponse | null = null;
    try {
      response = await searchSymbolReferences(
        owner,
        repo,
        candidate.symbol,
        githubToken,
        fetchFn,
        options,
      );
    } catch {
      response = null;
    }
    searches += 1;
    if (response === null) continue;

    const dead = isDeadOnArrivalFromSearch(candidate.file, response);
    if (dead !== true) continue;
    findings.push({
      file: candidate.file,
      line: candidate.line,
      symbol: candidate.symbol,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}
