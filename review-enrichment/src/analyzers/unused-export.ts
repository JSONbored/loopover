// Unused-export / dead-on-arrival scan (#2025). Flags exports NEWLY ADDED by the PR that have zero non-declaration
// references anywhere in the repo — net-new public surface with no callers yet. Narrow subset of caller-impact (#1509):
// only added direct exports, not changed/removed symbols. Parses added export declarations from the diff, then
// resolves references via repo-scoped GitHub Code Search (injected fetch). Bounded symbol + search caps; fail-safe
// on missing token/headSha, bad slug, search errors, incomplete results, or zero hits.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  UnusedExportFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { parseAddedExports } from "./undocumented-export.js";
import { isTestPath } from "./test-ratio.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_SYMBOLS = 10;
const MAX_SEARCHES = 10;
const MAX_FINDINGS = 25;
const MIN_SYMBOL_LEN = 3;
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

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

function isScannablePath(path: string): boolean {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  return Boolean(ext && SOURCE_EXTS.has(ext) && !SKIP_RE.test(path) && !isTestPath(path));
}

/** True when Code Search shows the symbol is dead-on-arrival: exactly one repo hit and it lives only in the
 *  declaring file (the export declaration). Multiple hits in the same file imply an internal reference; any hit
 *  outside the declaring file implies an external reference. Returns null when the response is unusable (fail-safe). */
export function isDeadOnArrivalFromSearch(
  exportFile: string,
  response: CodeSearchResponse | null,
): boolean | null {
  if (!response || response.incomplete_results) return null;
  const total = response.total_count ?? 0;
  if (total === 0) return null;
  const items = response.items ?? [];
  if (items.some((item) => item.path && item.path !== exportFile)) return false;
  if (total >= 2) return false;
  return true;
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
 *  references per GitHub Code Search. Fail-safe — returns no finding on missing token/headSha or search errors. */
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

  const findings: UnusedExportFinding[] = [];
  let searches = 0;
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    if (searches >= MAX_SEARCHES) break;

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
