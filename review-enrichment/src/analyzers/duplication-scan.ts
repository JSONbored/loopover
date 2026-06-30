// Full-file / near-verbatim duplication scan (#1520). Flags code a PR ADDS that is a near-verbatim duplicate of a
// block that already exists elsewhere in the repo — i.e. copy-paste instead of importing the existing helper. The
// no-checkout reviewer sees only the diff, so it cannot know the added lines already live in another file; this
// analyzer fetches the repo's git tree at headSha (ONE recursive call) plus a bounded set of candidate blobs and
// looks for a contiguous run of significant added lines that reappears verbatim (after whitespace normalization) in
// a candidate file. It is deliberately CONSERVATIVE — trivial/boilerplate lines are dropped and a long contiguous
// run is required — so it does not flag incidental overlap. It reports ONLY locations (`head:path:line` vs
// `source:path:line`) + the matched line count — never the code content. Fail-safe: returns [] without a token /
// headSha, on a bad repoFullName, or when the tree fetch fails; a single malformed candidate is skipped, never
// aborting the scan.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  DuplicationFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

const MIN_RUN = 8; // a contiguous run of >= this many significant normalized lines is required to flag a duplicate
const MAX_CANDIDATES = 40; // cap candidate files (closest-by-path first) we consider per scan
const MAX_FETCHES = 30; // global cap on candidate blob fetches per scan
const MAX_FINDINGS = 25; // keep the brief bounded
const MIN_SIGNIFICANT_LEN = 12; // lines shorter than this (after trim) are treated as trivial and dropped
const MAX_FILE_BYTES = 500_000; // skip an oversized candidate blob so one huge (likely generated) file can't eat the budget
const MAX_TREE_JSON_BYTES = 4 * 1024 * 1024; // recursive git tree can be large; bound it like asset-weight does
const MAX_BLOB_JSON_BYTES = 1024 * 1024; // a base64 blob payload is ~4/3 of the file; bound the JSON we read

// Source-code extensions whose copy-paste is meaningful. Text data / config / lockfiles are intentionally excluded.
const SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rb", "java", "kt", "rs",
  "c", "cc", "cpp", "h", "hpp", "cs", "php", "swift", "scala",
]);

// A single repo path segment (owner or name): word chars, dot, dash only. Whole-segment `.`/`..` are rejected
// separately so a hostile repoFullName can't traverse or redirect the token-bearing request to another repository.
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "gittensory-review-enrichment",
  };
}

/** Parse `owner/repo`, rejecting anything that isn't exactly two safe segments (no traversal, no extra slashes) so a
 *  hostile `repoFullName` cannot redirect the token-bearing request elsewhere. Returns null when unsafe. */
function parseRepo(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  for (const seg of [owner, repo]) {
    if (!seg || seg === "." || seg === ".." || !REPO_SEGMENT.test(seg)) {
      return null;
    }
  }
  return { owner: owner!, repo: repo! };
}

/** Fetch JSON from a GitHub git endpoint through the shared bounded helper. Mirrors asset-weight: when an analysis
 *  context is supplied its caching/metered `fetchJson` is used, otherwise the bare `boundedFetchJson`. Returns the
 *  parsed body on a 2xx with valid JSON, or null on any non-OK / malformed / over-budget / network outcome so the
 *  caller fails safe. */
async function fetchGithubJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
  endpointCategory: "github-trees" | "github-blobs",
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory,
    headers: githubHeaders(token),
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "duplication",
    subcall: endpointCategory,
    maxBytes:
      endpointCategory === "github-trees"
        ? MAX_TREE_JSON_BYTES
        : MAX_BLOB_JSON_BYTES,
    maxCallsPerCategory:
      endpointCategory === "github-blobs" ? MAX_FETCHES : 1,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

function extOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return null; // no extension, or the dot is in a directory segment
  return path.slice(dot + 1).toLowerCase();
}

function isSourceExt(path: string): boolean {
  const ext = extOf(path);
  return ext !== null && SOURCE_EXTS.has(ext);
}

/** Paths that are generated / vendored / minified / type-declaration: copy-paste there is noise, not a defect. */
function isExcludedPath(path: string): boolean {
  if (path.endsWith(".d.ts")) return true;
  if (path.includes(".min.")) return true;
  const lower = path.toLowerCase();
  for (const seg of lower.split("/")) {
    if (
      seg === "node_modules" ||
      seg === "dist" ||
      seg === "build" ||
      seg === "vendor"
    ) {
      return true;
    }
  }
  return false;
}

/** Normalize a source line for comparison: trim + collapse internal whitespace to single spaces. Returns null when
 *  the line is blank or "trivial" (too short, pure punctuation/braces, or bare boilerplate like a lone `import`) so
 *  incidental matches on closing braces / import keywords cannot accumulate into a false-positive run. */
export function normalizeLine(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  if (collapsed.length < MIN_SIGNIFICANT_LEN) return null;
  // Pure punctuation / brackets (e.g. `});`, `} else {`-free closers) carry no copy-paste signal.
  if (!/[A-Za-z0-9]/.test(collapsed)) return null;
  // Bare import/include/use boilerplate that legitimately recurs across files. `export` is intentionally NOT dropped
  // (an `export function`/`export const` declaration is meaningful and part of a copy-pasted block); only re-exports
  // of the form `export ... from ...` are import-like.
  if (/^(import|from|using|use|#include|package|require)\b/.test(collapsed)) {
    return null;
  }
  if (/^export\b.*\bfrom\b/.test(collapsed)) return null; // re-export, e.g. `export { x } from "./y"`
  return collapsed;
}

interface NormBlock {
  /** Normalized significant lines, in order. */
  norm: string[];
  /** Parallel array: the ORIGINAL new-file line number for each entry of `norm`. */
  lineNos: number[];
}

/** Parse a unified-diff `patch` into blocks of ADDED significant lines with their new-file line numbers. Lines are
 *  grouped into a fresh block whenever the added run is broken (a context/removed line, or a trivial line dropped by
 *  normalization), so a contiguous run requirement is meaningful. */
export function extractAddedBlocks(patch: string | undefined): NormBlock[] {
  if (!patch) return [];
  const blocks: NormBlock[] = [];
  let current: NormBlock | null = null;
  let newLine = 0;
  let inHunk = false;

  const flush = () => {
    if (current && current.norm.length) blocks.push(current);
    current = null;
  };

  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      flush();
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+++")) continue; // file header inside the patch, not an added line
    if (line.startsWith("+")) {
      const norm = normalizeLine(line.slice(1));
      if (norm === null) {
        // A trivial added line breaks the contiguous significant run.
        flush();
      } else {
        if (!current) current = { norm: [], lineNos: [] };
        current.norm.push(norm);
        current.lineNos.push(newLine);
      }
      newLine++;
      continue;
    }
    if (line.startsWith("-")) {
      // Removed line: does not advance the new-file counter, breaks the added run.
      flush();
      continue;
    }
    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line.
      continue;
    }
    // Context line (starts with a space, or an empty line in the patch): advances new-file counter, breaks the run.
    flush();
    newLine++;
  }
  flush();
  return blocks;
}

/** Split a full file's text into blocks of significant lines (with 1-based source line numbers), breaking a block
 *  at every blank/trivial line — the same gap-aware grouping `extractAddedBlocks` uses. Indexing each block
 *  separately means a matched run can never bridge across a blank or trivial line in the source file. */
function normalizeFileBlocks(text: string): NormBlock[] {
  const blocks: NormBlock[] = [];
  let current: NormBlock | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const n = normalizeLine(lines[i]!);
    if (n === null) {
      if (current && current.norm.length) blocks.push(current);
      current = null;
    } else {
      if (!current) current = { norm: [], lineNos: [] };
      current.norm.push(n);
      current.lineNos.push(i + 1);
    }
  }
  if (current && current.norm.length) blocks.push(current);
  return blocks;
}

interface GramIndex {
  block: NormBlock;
  /** Map of joined MIN_RUN-window key → list of window start indices in `block.norm`. */
  windows: Map<string, number[]>;
}

/** Build a rolling MIN_RUN-line window index over a candidate file's significant lines, for fast run lookup. */
function buildGramIndex(block: NormBlock): GramIndex {
  const windows = new Map<string, number[]>();
  for (let i = 0; i + MIN_RUN <= block.norm.length; i++) {
    const key = block.norm.slice(i, i + MIN_RUN).join("\n");
    const list = windows.get(key);
    if (list) list.push(i);
    else windows.set(key, [i]);
  }
  return { block, windows };
}

/** Find the LONGEST contiguous run shared between an added block and an indexed candidate, anchored on a matching
 *  MIN_RUN window then extended forward. Returns the head + source line numbers of the run start and its length,
 *  or null when no run of >= MIN_RUN significant lines is shared. */
function longestSharedRun(
  added: NormBlock,
  index: GramIndex,
): { headLine: number; sourceLine: number; length: number } | null {
  const cand = index.block;
  let best: { headLine: number; sourceLine: number; length: number } | null =
    null;
  for (let a = 0; a + MIN_RUN <= added.norm.length; a++) {
    const key = added.norm.slice(a, a + MIN_RUN).join("\n");
    const starts = index.windows.get(key);
    if (!starts) continue;
    for (const c of starts) {
      // Verify + extend the run forward from the matched window.
      let len = MIN_RUN;
      while (
        a + len < added.norm.length &&
        c + len < cand.norm.length &&
        added.norm[a + len] === cand.norm[c + len]
      ) {
        len++;
      }
      if (!best || len > best.length) {
        best = {
          headLine: added.lineNos[a]!,
          sourceLine: cand.lineNos[c]!,
          length: len,
        };
      }
    }
  }
  return best;
}

/** Fetch the recursive git tree at `sha`. Returns the blob entries (path + blob sha) or null on a non-OK / malformed
 *  reply / network error so the caller fails safe. */
async function fetchTree(
  owner: string,
  repo: string,
  sha: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<Array<{ path: string; sha: string }> | null> {
  if (!SHA_RE.test(sha)) return null;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}?recursive=1`;
  const json = await fetchGithubJson<{
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
    truncated?: boolean;
  }>(url, token, fetchImpl, options, "github-trees");
  if (!json || !Array.isArray(json.tree)) return null;
  // `json.truncated` (very large repos) is intentionally not treated as an error: this analyzer is best-effort and
  // additive, so a partial tree only means fewer candidate files to compare against. That can at worst MISS a
  // duplicate (a false negative), never produce a wrong finding, so scanning the partial tree is acceptable.
  const out: Array<{ path: string; sha: string }> = [];
  for (const entry of json.tree) {
    if (
      entry.type === "blob" &&
      typeof entry.path === "string" &&
      typeof entry.sha === "string"
    ) {
      out.push({ path: entry.path, sha: entry.sha });
    }
  }
  return out;
}

/** Fetch a single git blob's decoded UTF-8 content, or null on a non-OK / malformed reply / network error. Only
 *  base64-encoded string content is decoded — anything else fails safe to null. */
async function fetchBlob(
  owner: string,
  repo: string,
  blobSha: string,
  token: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<string | null> {
  if (!SHA_RE.test(blobSha)) return null;
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(blobSha)}`;
  const json = await fetchGithubJson<{
    content?: string;
    encoding?: string;
  }>(url, token, fetchImpl, options, "github-blobs");
  if (!json) return null;
  if (json.encoding !== "base64" || typeof json.content !== "string") {
    return null;
  }
  // Cap on the encoded size first so a huge blob never burns CPU on decode, then on the true decoded byte length.
  if (json.content.length > MAX_FILE_BYTES * 2) return null;
  const decoded = decodeBase64Utf8(json.content);
  if (!decoded || decoded.byteLength > MAX_FILE_BYTES) return null;
  return decoded.text;
}

/** Worker-safe base64 → UTF-8 decode (no Node `Buffer` dependency, so the Cloudflare Worker deployment path works,
 *  not only Node). GitHub wraps blob `content` with newlines, which `atob` rejects, so whitespace is stripped first.
 *  Returns the decoded text plus its true UTF-8 byte length, or null on malformed base64 (fail safe, never throws). */
export function decodeBase64Utf8(content: string): { text: string; byteLength: number } | null {
  try {
    const binary = atob(content.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // `fatal: true` throws on invalid UTF-8, so a binary/non-text blob fails safe to null (skipped) instead of being
    // turned into replacement-character garbage that could be compared as if it were source.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: bytes.length };
  } catch {
    return null;
  }
}

/** Score a candidate path by how close it sits to any changed path: more shared leading directory segments ⇒ higher
 *  score (a copy-pasted helper most often lives near the file that should have imported it). */
function proximityScore(candidate: string, changedDirs: string[][]): number {
  const candSegs = candidate.split("/").slice(0, -1);
  let best = 0;
  for (const dir of changedDirs) {
    let shared = 0;
    const max = Math.min(candSegs.length, dir.length);
    while (shared < max && candSegs[shared] === dir[shared]) shared++;
    if (shared > best) best = shared;
  }
  return best;
}

/** Analyzer entrypoint: flag added code that is a near-verbatim duplicate of an existing block elsewhere in the repo.
 *  Fail-safe (returns [] without a token/headSha, on a bad repoFullName, or on a failed tree fetch). */
export async function scanDuplication(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DuplicationFinding[]> {
  const token = req.githubToken;
  if (!token || !req.headSha) return [];
  if (options.signal?.aborted) return [];
  const repo = parseRepo(req.repoFullName);
  if (!repo) return [];

  // Changed source files (kept) and their added significant blocks. Test/spec files are KEPT — copy-pasted tests are
  // a real maintenance smell too — only generated/vendored/minified/declaration files are excluded.
  const changed = (req.files ?? []).filter(
    (f) =>
      f.status !== "removed" &&
      isSourceExt(f.path) &&
      !isExcludedPath(f.path),
  );
  if (!changed.length) return [];

  const changedPaths = new Set(changed.map((f) => f.path));
  const changedExts = new Set<string>();
  for (const f of changed) {
    const ext = extOf(f.path);
    if (ext) changedExts.add(ext);
  }

  const addedByFile: Array<{ path: string; ext: string | null; blocks: NormBlock[] }> = [];
  for (const f of changed) {
    const blocks = extractAddedBlocks(f.patch).filter(
      (b) => b.norm.length >= MIN_RUN,
    );
    if (blocks.length) addedByFile.push({ path: f.path, ext: extOf(f.path), blocks });
  }
  if (!addedByFile.length) return [];

  const tree = await fetchTree(
    repo.owner,
    repo.repo,
    req.headSha,
    token,
    fetchImpl,
    options,
  );
  if (tree === null) return [];

  // Group candidate blobs BY extension, then proximity-sort + cap WITHIN each extension bucket (MAX_CANDIDATES each).
  // Scanning is then round-robin across buckets under one global fetch budget (below), so no single extension's
  // candidates can starve another's, while the TOTAL blob fetches stay bounded by MAX_FETCHES.
  const changedDirs = [...changedPaths].map((p) => p.split("/").slice(0, -1));
  const candidatesByExt = new Map<string, Array<{ path: string; sha: string }>>();
  for (const entry of tree) {
    if (changedPaths.has(entry.path) || isExcludedPath(entry.path)) continue;
    const ext = extOf(entry.path);
    if (ext === null || !changedExts.has(ext)) continue;
    const bucket = candidatesByExt.get(ext);
    if (bucket) bucket.push(entry);
    else candidatesByExt.set(ext, [entry]);
  }
  for (const [ext, bucket] of candidatesByExt) {
    bucket.sort((a, b) => {
      const sa = proximityScore(a.path, changedDirs);
      const sb = proximityScore(b.path, changedDirs);
      return sb !== sa ? sb - sa : a.path.localeCompare(b.path);
    });
    candidatesByExt.set(ext, bucket.slice(0, MAX_CANDIDATES));
  }

  // Added blocks grouped by extension, so each extension is scanned only against its own candidate bucket.
  const addedByExt = new Map<string, Array<{ path: string; blocks: NormBlock[] }>>();
  for (const f of addedByFile) {
    if (f.ext === null) continue;
    const arr = addedByExt.get(f.ext);
    if (arr) arr.push({ path: f.path, blocks: f.blocks });
    else addedByExt.set(f.ext, [{ path: f.path, blocks: f.blocks }]);
  }

  const findings: DuplicationFinding[] = [];
  const seen = new Set<string>();

  // Scan round-robin across extensions under ONE global MAX_FETCHES budget: fair (each changed extension gets its
  // turn, so none is starved) AND bounded (total blob fetches never exceed MAX_FETCHES, regardless of how many
  // extensions changed). One pointer per extension bucket; we cycle until the budget is spent or every bucket drains.
  const buckets = [...addedByExt.entries()]
    .map(([ext, addedFiles]) => ({
      addedFiles,
      cands: candidatesByExt.get(ext) ?? [],
      cursor: 0,
    }))
    .filter((bk) => bk.cands.length > 0);

  let fetches = 0;
  let aborted = false;
  let progressed = true;
  while (fetches < MAX_FETCHES && progressed && !aborted) {
    progressed = false;
    for (const bk of buckets) {
      if (fetches >= MAX_FETCHES) break;
      if (bk.cursor >= bk.cands.length) continue;
      if (options.signal?.aborted) {
        aborted = true;
        break;
      }
      const cand = bk.cands[bk.cursor];
      bk.cursor += 1;
      if (!cand) continue;
      progressed = true;
      fetches += 1;
      const text = await fetchBlob(
        repo.owner,
        repo.repo,
        cand.sha,
        token,
        fetchImpl,
        options,
      );
      if (text === null) continue; // bad/empty/oversized candidate — skip, never abort (size capped in fetchBlob)
      // Index each gap-delimited block of the candidate separately so a run cannot bridge a blank/trivial line.
      const indices = normalizeFileBlocks(text)
        .filter((b) => b.norm.length >= MIN_RUN)
        .map(buildGramIndex);
      if (!indices.length) continue;

      for (const file of bk.addedFiles) {
        for (const block of file.blocks) {
          let best: { headLine: number; sourceLine: number; length: number } | null = null;
          for (const index of indices) {
            const run = longestSharedRun(block, index);
            if (run && (!best || run.length > best.length)) best = run;
          }
          if (!best) continue;
          const key = `${file.path}:${best.headLine}|${cand.path}:${best.sourceLine}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({
            file: file.path,
            line: best.headLine,
            sourceFile: cand.path,
            sourceLine: best.sourceLine,
            lines: best.length,
          });
        }
      }
    }
  }

  return findings.sort((a, b) => b.lines - a.lines).slice(0, MAX_FINDINGS);
}
