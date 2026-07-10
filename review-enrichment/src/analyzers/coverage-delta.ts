// Coverage-delta analyzer (#1516, part of #1499). For the lines a PR ADDS, reads the project's OWN latest
// successful CI coverage report — pulled from the GitHub Actions artifact of the PR head commit — and flags the
// added lines that report records as executed zero times: real measured test gaps on exactly the touched lines,
// not a heuristic about whether tests "look" present. This is heavy/external analysis the no-checkout
// `claude --print` reviewer cannot do; the REES returns it as a brief block the engine splices into the review
// (additive + fail-safe). Distinct from the test-ratio analyzer (added test vs source line volume) and the
// flaky-test analyzer: this intersects the PR's added new-file lines with the coverage report's zero-hit lines.
// Reports only file + line numbers, never code. Any missing token/artifact/parse fails safe to [] — so a fetch
// error can never manufacture a false "untested" finding.
import { inflateRawSync } from "node:zlib";
import type {
  AnalyzerDiagnostics,
  CoverageDeltaFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_RUNS_PROBED = 5; // recent successful runs to search for a coverage artifact
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024; // skip an artifact zip larger than this (bounded download)
const MAX_ENTRY_BYTES = 4 * 1024 * 1024; // skip a single uncompressed zip entry larger than this
const MAX_ZIP_ENTRIES = 64; // cap central-directory entries inspected from untrusted artifacts
const MAX_TOTAL_ENTRY_BYTES = 8 * 1024 * 1024; // cap retained decompressed coverage-report bytes per artifact
const MAX_FILES_REPORTED = 15; // cap findings so the brief stays bounded
const MAX_LINES_PER_FILE = 20; // cap reported uncovered lines per file
// Artifact names that plausibly hold a coverage report; matched case-insensitively against the artifact name.
const COVERAGE_ARTIFACT_RE = /cover|lcov/i;

/** file path -> the 1-based line numbers the coverage report records as executed zero times. */
type CoverageMap = Map<string, Set<number>>;

type CoverageKind = "lcov" | "istanbul" | "cobertura";

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub Actions workflow-run this analyzer reads. */
interface WorkflowRun {
  id?: number;
  conclusion?: string | null;
  created_at?: string;
}

/** The slice of a GitHub Actions artifact this analyzer reads. */
interface Artifact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
}

/** A decompressed zip entry: its archive name and raw bytes. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

function addUncovered(map: CoverageMap, file: string, line: number): void {
  let set = map.get(file);
  if (!set) {
    set = new Set<number>();
    map.set(file, set);
  }
  set.add(line);
}

/** The 1-based new-file line numbers a unified-diff patch ADDS. Operates on GitHub's per-file `patch` (which has
 *  no `+++`/`---` headers). Pure — returns [] for an empty patch or one with no valid hunk header. */
export function addedLineNumbers(patch: string): number[] {
  const lines: number[] = [];
  if (!patch) return lines;
  let newLine = 0;
  let active = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!header) {
        active = false;
        continue;
      }
      newLine = Number(header[1]);
      active = true;
      continue;
    }
    if (!active) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = line[0];
    if (marker === "+") {
      lines.push(newLine);
      newLine += 1;
    } else if (marker !== "-") {
      newLine += 1; // context line advances the new-file counter; a "-" removal does not
    }
  }
  return lines;
}

/** Parse an LCOV report into file -> zero-hit line numbers (`DA:<line>,<hits>` rows whose hit count is 0). Pure. */
export function parseLcov(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let file = "";
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = line.slice(3);
    } else if (line === "end_of_record") {
      file = "";
    } else if (file && line.startsWith("DA:")) {
      const [num, hits] = line.slice(3).split(",");
      const n = Number(num);
      if (Number.isInteger(n) && n > 0 && Number(hits) === 0) addUncovered(map, file, n);
    }
  }
  return map;
}

/** Parse an Istanbul/nyc `coverage-final.json` into file -> zero-hit line numbers. Each file entry maps statement
 *  ids to hit counts (`s`) and statement ids to source ranges (`statementMap`); a zero-hit statement is uncovered
 *  at its start line. Pure — malformed JSON or an unexpected shape yields an empty map. */
export function parseIstanbulJson(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return map;
  }
  if (typeof data !== "object" || data === null) return map;
  for (const [file, cov] of Object.entries(data as Record<string, unknown>)) {
    if (typeof cov !== "object" || cov === null) continue;
    const { s, statementMap } = cov as {
      s?: Record<string, unknown>;
      statementMap?: Record<string, { start?: { line?: unknown } } | undefined>;
    };
    if (!s || !statementMap) continue;
    for (const [id, hits] of Object.entries(s)) {
      if (hits !== 0) continue;
      const start = statementMap[id]?.start?.line;
      if (typeof start === "number" && Number.isInteger(start) && start > 0) {
        addUncovered(map, file, start);
      }
    }
  }
  return map;
}

/** Parse a Cobertura XML report into file -> zero-hit line numbers. Scans line-by-line (no backtracking regex)
 *  for `<class filename="...">` scope and `<line number="..." hits="0" ...>` rows. Pure. */
export function parseCoberturaXml(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let file = "";
  for (const raw of content.split("\n")) {
    if (raw.includes("<class")) {
      const m = /filename="([^"]+)"/.exec(raw);
      if (m && m[1]) file = m[1];
    } else if (raw.includes("</class>")) {
      file = "";
    } else if (file && raw.includes("<line")) {
      const num = /\bnumber="(\d+)"/.exec(raw);
      const hits = /\bhits="(\d+)"/.exec(raw);
      if (num && num[1] && hits && Number(hits[1]) === 0) addUncovered(map, file, Number(num[1]));
    }
  }
  return map;
}

/** Minimal ZIP reader over the central directory. Supports stored (method 0) and deflated (method 8) entries and
 *  skips anything else. Bytes-bounded; returns [] for a truncated or signature-less archive. Pure. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  if (buf.length < 22) return entries;
  // End-of-central-directory signature 0x06054b50, scanning back past its (up to 65535-byte) trailing comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return entries;
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdStart = buf.readUInt32LE(eocd + 16);
  if (cdStart + cdSize > buf.length) return entries;
  let pos = cdStart;
  let inspected = 0;
  let retainedBytes = 0;
  while (pos + 46 <= cdStart + cdSize && inspected < MAX_ZIP_ENTRIES) {
    inspected += 1;
    if (buf.readUInt32LE(pos) !== 0x02014b50) break; // central-directory file header
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;
    if (!coverageFileKind(name)) continue;
    if (localOffset + 30 > buf.length) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) continue;
    const chunk = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      if (chunk.length > MAX_ENTRY_BYTES || retainedBytes + chunk.length > MAX_TOTAL_ENTRY_BYTES) continue;
      entries.push({ name, data: chunk });
      retainedBytes += chunk.length;
    } else if (method === 8) {
      try {
        const data = inflateRawSync(chunk, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_ENTRY_BYTES - retainedBytes) });
        entries.push({ name, data });
        retainedBytes += data.length;
      } catch {
        continue; // corrupt deflate stream or output over the remaining cap -> skip this entry
      }
    }
  }
  return entries;
}

/** The coverage format implied by a file name, or null when it is not a recognized report. Pure. */
export function coverageFileKind(name: string): CoverageKind | null {
  const base = (name.split("/").pop() ?? "").toLowerCase();
  if (base === "lcov.info" || base.endsWith(".lcov")) return "lcov";
  if (base === "coverage-final.json") return "istanbul";
  if (base === "cobertura.xml" || base === "coverage.xml") return "cobertura";
  return null;
}

function parseCoverage(kind: CoverageKind, content: string): CoverageMap {
  if (kind === "lcov") return parseLcov(content);
  if (kind === "istanbul") return parseIstanbulJson(content);
  return parseCoberturaXml(content);
}

/** True when a coverage report path refers to the PR file — exact, or the report path ends with `/<prFile>`
 *  (coverage tools commonly emit workspace-absolute paths). Pure. */
export function pathMatches(coveragePath: string, prFile: string): boolean {
  const c = coveragePath.replace(/\\/g, "/");
  const p = prFile.replace(/\\/g, "/");
  return c === p || c.endsWith(`/${p}`);
}

/** Fetch + parse JSON with the shared bounded-fetch guard rails; returns the parsed body or null on any
 *  error/non-200 so the caller degrades that one lookup rather than throwing. */
async function fetchGithubJson<T>(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  category: string,
  options: ScanOptions,
): Promise<T | null> {
  const fetchOptions = {
    endpointCategory: category,
    headers,
    signal: options.signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "coverage-delta",
    subcall: category,
    maxBytes: 1024 * 1024,
    maxCallsPerCategory: MAX_RUNS_PROBED + 2,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Download an artifact zip via the injected fetch, bounded by a declared and actual byte cap. Returns the bytes
 *  or null on any error/non-ok/oversize. GitHub redirects the zip endpoint to a signed URL; fetch follows it. */
async function fetchArtifactZip(
  url: string,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const response = await fetchFn(url, { headers, signal });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) return null;
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

/** Analyzer entrypoint: PR added lines -> latest successful CI run for headSha -> coverage artifact -> parsed
 *  zero-hit lines -> intersection with the added lines. Fail-safe: any missing token/head-sha/invalid slug/failed
 *  fetch/unparseable artifact/aborted signal degrades to []. */
export async function scanCoverageDelta(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CoverageDeltaFinding[]> {
  const { repoFullName, headSha, githubToken, files = [] } = req;
  if (!githubToken || !headSha) return [];
  const parts = repoFullName.split("/");
  if (parts.length !== 2) return [];
  const [owner, repo] = parts;
  if (!owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  // Index the PR's added new-file lines per file before any network round-trip; nothing to check if none.
  const changed = new Map<string, number[]>();
  for (const file of files) {
    const added = addedLineNumbers(file.patch ?? "");
    if (added.length > 0) changed.set(file.path, added);
  }
  if (changed.size === 0) return [];

  const headers = githubHeaders(githubToken);
  const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const runsBody = await fetchGithubJson<{ workflow_runs?: WorkflowRun[] }>(
    `${base}/actions/runs?head_sha=${encodeURIComponent(headSha)}&status=success&per_page=20`,
    headers,
    fetchFn,
    "github-actions-runs",
    options,
  );
  const runs = (runsBody?.workflow_runs ?? [])
    .filter((run): run is WorkflowRun & { id: number } => run.conclusion === "success" && typeof run.id === "number")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, MAX_RUNS_PROBED);
  if (runs.length === 0) return [];

  let coverage: CoverageMap | null = null;
  for (const run of runs) {
    if (options.signal?.aborted || coverage) break;
    const artifactsBody = await fetchGithubJson<{ artifacts?: Artifact[] }>(
      `${base}/actions/runs/${run.id}/artifacts`,
      headers,
      fetchFn,
      "github-actions-artifacts",
      options,
    );
    const artifact = (artifactsBody?.artifacts ?? [])
      .filter(
        (a): a is Artifact & { id: number; name: string } =>
          typeof a.id === "number" &&
          typeof a.name === "string" &&
          COVERAGE_ARTIFACT_RE.test(a.name) &&
          (a.size_in_bytes ?? 0) <= MAX_ARTIFACT_BYTES,
      )
      .sort((a, b) => (a.size_in_bytes ?? 0) - (b.size_in_bytes ?? 0))[0];
    if (!artifact) continue;
    const zip = await fetchArtifactZip(`${base}/actions/artifacts/${artifact.id}/zip`, headers, fetchFn, options.signal);
    if (!zip) continue;
    for (const entry of readZipEntries(zip)) {
      const kind = coverageFileKind(entry.name);
      if (!kind) continue;
      const parsed = parseCoverage(kind, entry.data.toString("utf8"));
      if (parsed.size > 0) {
        coverage = parsed;
        break;
      }
    }
  }
  if (!coverage) return [];

  const findings: CoverageDeltaFinding[] = [];
  for (const [file, addedLines] of changed) {
    if (findings.length >= MAX_FILES_REPORTED) break;
    let match: Set<number> | undefined;
    for (const [coveragePath, zeroHit] of coverage) {
      if (pathMatches(coveragePath, file)) {
        match = zeroHit;
        break;
      }
    }
    if (!match) continue;
    const zero = match;
    const uncoveredLines = addedLines.filter((line) => zero.has(line)).slice(0, MAX_LINES_PER_FILE);
    if (uncoveredLines.length > 0) findings.push({ file, uncoveredLines });
  }
  return findings;
}
