// Coverage-delta analyzer (#1516). Finds added/changed lines in the PR that are not covered by the
// project's own CI test suite. Uses the GitHub Actions artifact API to download the most recent
// successful run's coverage report (lcov / Istanbul JSON / Cobertura XML), parses line-hit counts,
// and correlates them against the PR patch hunks — all without a repo checkout.
// ZIP extraction uses Node.js built-in zlib (DEFLATE) so no extra dependency is needed.
// Fail-safe: returns [] on any network error, non-ok response, or unparseable artifact.
import type { EnrichRequest, CoverageDeltaFinding } from "../types.js";
import { inflateRawSync } from "node:zlib";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;   // 5 MB cap on artifact ZIP (skip oversized ones)
const MAX_COVERAGE_BYTES = 2 * 1024 * 1024;   // 2 MB cap on any single uncompressed file in the ZIP
const MAX_RUNS_TO_CHECK = 5;                   // successful runs to search before giving up
const MAX_FILES_REPORTED = 15;
const MAX_LINES_PER_FILE = 20;

// Artifact names that are likely coverage reports. Case-insensitive match against artifact.name.
const COVERAGE_ARTIFACT_RE = /coverage|lcov|cov[-_]report|test[-_]cov|codecoverage/i;

// Map of normalized file path → Set<number> of 1-indexed uncovered line numbers.
type CoverageMap = Map<string, Set<number>>;

interface WorkflowRun {
  id: number;
  conclusion: string | null;
  created_at: string;
}

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
}

/** ZIP entry returned by readZipEntries. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

// ── Patch parsing ─────────────────────────────────────────────────────────────

/** Extract 1-indexed line numbers (in the NEW file) for all added lines from a unified diff patch. */
export function extractChangedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { newLine = Number(hunk[1]!); continue; }
    if (line.startsWith("+")) { lines.add(newLine); newLine++; }
    else if (!line.startsWith("-")) { newLine++; }
  }
  return lines;
}

// ── Coverage format parsers ───────────────────────────────────────────────────

/** Parse an lcov report into a map of file → uncovered line numbers (DA:line,0 entries). */
export function parseLcov(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let currentFile = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3);
      if (!map.has(currentFile)) map.set(currentFile, new Set());
    } else if (line.startsWith("DA:") && currentFile) {
      const parts = line.slice(3).split(",");
      const lineNum = Number(parts[0]);
      const hits = Number(parts[1]);
      if (Number.isFinite(lineNum) && Number.isFinite(hits) && hits === 0) {
        map.get(currentFile)!.add(lineNum);
      }
    } else if (line === "end_of_record") {
      currentFile = "";
    }
  }
  return map;
}

/** Parse an Istanbul/NYC coverage-final.json into a map of file → uncovered line numbers.
 *  Each entry maps statement keys to hit counts; uncovered = s[key] === 0. */
export function parseIstanbulJson(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return map;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return map;

  for (const [filePath, fileCov] of Object.entries(data)) {
    if (typeof fileCov !== "object" || fileCov === null) continue;
    const fc = fileCov as {
      s?: Record<string, number>;
      statementMap?: Record<string, { start: { line: number } }>;
    };
    if (!fc.s || !fc.statementMap) continue;
    const uncovered = new Set<number>();
    for (const [key, hits] of Object.entries(fc.s)) {
      if (hits === 0) {
        const stmt = fc.statementMap[key];
        if (stmt) uncovered.add(stmt.start.line);
      }
    }
    if (uncovered.size > 0) map.set(filePath, uncovered);
  }
  return map;
}

/** Parse a Cobertura XML coverage report into a map of file → uncovered line numbers.
 *  Uses line-by-line scanning to avoid backtracking `[\s\S]*?` patterns (ReDoS risk on XML). */
export function parseCoberturaXml(content: string): CoverageMap {
  const map: CoverageMap = new Map();
  let currentFile = "";
  for (const rawLine of content.split("\n")) {
    if (rawLine.includes("<class")) {
      const m = /filename="([^"]+)"/.exec(rawLine);
      if (m) {
        currentFile = m[1]!;
        if (!map.has(currentFile)) map.set(currentFile, new Set());
      }
    } else if (rawLine.includes("</class>")) {
      currentFile = "";
    } else if (rawLine.includes("<line") && currentFile) {
      const numM = /number="(\d+)"/.exec(rawLine);
      const hitsM = /hits="(\d+)"/.exec(rawLine);
      if (numM && hitsM && Number(hitsM[1]) === 0) {
        map.get(currentFile)?.add(Number(numM[1]));
      }
    }
  }
  return map;
}

// ── ZIP reader ────────────────────────────────────────────────────────────────

/** Minimal ZIP reader using Node.js built-in zlib. Reads from the central directory for reliability.
 *  Supports stored (method 0) and deflated (method 8) entries; skips unknown compression methods. */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  if (buf.length < 22) return entries;

  // Locate End of Central Directory (EOCD) by scanning backwards for its signature 0x06054b50.
  // The comment field (up to 65535 bytes) sits after the fixed 22-byte EOCD, so scan that far back.
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break; }
  }
  if (eocdAt < 0) return entries;

  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdStart = buf.readUInt32LE(eocdAt + 16);
  if (cdStart + cdSize > buf.length) return entries;

  let pos = cdStart;
  while (pos + 46 <= cdStart + cdSize) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break; // central directory entry signature
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf-8");

    const entrySize = 46 + nameLen + extraLen + commentLen;
    if (pos + entrySize > cdStart + cdSize) break;
    pos += entrySize;

    // Read local file header to find the actual data offset (local extra can differ from central).
    if (localOffset + 30 > buf.length) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) continue;
    const compData = buf.slice(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      if (compData.length > MAX_COVERAGE_BYTES) continue; // stored entry too large
      data = compData;
    } else if (method === 8) {
      try { data = inflateRawSync(compData, { maxOutputLength: MAX_COVERAGE_BYTES }); }
      catch { continue; } // RangeError from maxOutputLength or corrupt data → skip entry
    } else {
      continue; // unsupported compression method
    }

    entries.push({ name, data });
  }
  return entries;
}

// ── Coverage file identification and parsing dispatch ─────────────────────────

function coverageFileKind(name: string): "lcov" | "istanbul" | "cobertura" | null {
  const base = name.split("/").pop()?.toLowerCase() ?? "";
  if (base === "lcov.info" || base.endsWith(".lcov")) return "lcov";
  if (base === "coverage-final.json") return "istanbul";
  if (base === "coverage.xml" || base === "cobertura.xml") return "cobertura";
  return null;
}

function parseCoverage(kind: "lcov" | "istanbul" | "cobertura", content: string): CoverageMap {
  if (kind === "lcov") return parseLcov(content);
  if (kind === "istanbul") return parseIstanbulJson(content);
  return parseCoberturaXml(content);
}

/** True when covPath equals prFile or ends with /<prFile> (handles absolute workspace-prefixed paths).
 *  Suffix matching can produce false positives when two distinct paths share a trailing component
 *  (e.g. `lib/utils.ts` in coverage matching PR file `utils.ts`); acceptable given the heuristic nature. */
function pathMatches(covPath: string, prFile: string): boolean {
  const c = covPath.replace(/\\/g, "/");
  const p = prFile.replace(/\\/g, "/");
  return c === p || c.endsWith("/" + p);
}

// ── Analyzer entrypoint ───────────────────────────────────────────────────────

/** Analyzer entrypoint: find added/changed lines with zero test coverage using the repo's own CI run. */
export async function scanCoverageDelta(
  req: EnrichRequest,
  fetchFn: typeof fetch,
  opts?: { signal?: AbortSignal },
): Promise<CoverageDeltaFinding[]> {
  const { repoFullName, headSha, githubToken, files = [] } = req;
  if (!githubToken || !headSha) return [];

  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) return [];
  const eOwner = encodeURIComponent(owner);
  const eRepo = encodeURIComponent(repo);

  // Build the changed-line index from the PR patch before touching the network.
  const changedLines = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.patch) continue;
    const lines = extractChangedLines(file.patch);
    if (lines.size > 0) changedLines.set(file.path, lines);
  }
  if (changedLines.size === 0) return [];

  const headers: Record<string, string> = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Fetch recent successful workflow runs for this head SHA.
  let runs: WorkflowRun[];
  try {
    const runsResp = await fetchFn(
      `https://api.github.com/repos/${eOwner}/${eRepo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=10`,
      { headers, signal: opts?.signal },
    );
    if (!runsResp.ok) return [];
    const runsJson = (await runsResp.json()) as { workflow_runs?: WorkflowRun[] };
    runs = (runsJson.workflow_runs ?? [])
      .filter((r) => r.conclusion === "success")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, MAX_RUNS_TO_CHECK);
  } catch {
    return [];
  }

  if (runs.length === 0) return [];

  // Walk runs most-recent-first and stop at the first one that has a coverage artifact.
  let coverageArtifact: Artifact | null = null;

  for (const run of runs) {
    let artifacts: Artifact[];
    try {
      const artResp = await fetchFn(
        `https://api.github.com/repos/${eOwner}/${eRepo}/actions/runs/${run.id}/artifacts`,
        { headers, signal: opts?.signal },
      );
      if (!artResp.ok) continue;
      const artJson = (await artResp.json()) as { artifacts?: Artifact[] };
      artifacts = artJson.artifacts ?? [];
    } catch {
      continue;
    }

    const found = artifacts
      .filter((a) => COVERAGE_ARTIFACT_RE.test(a.name) && a.size_in_bytes <= MAX_ARTIFACT_BYTES)
      .sort((a, b) => a.size_in_bytes - b.size_in_bytes)[0];

    if (found) { coverageArtifact = found; break; }
  }

  if (!coverageArtifact) return [];

  // Download the artifact ZIP (GitHub responds with a redirect to a signed S3 URL; fetch follows it).
  let zipBuffer: Buffer;
  try {
    const zipResp = await fetchFn(
      `https://api.github.com/repos/${eOwner}/${eRepo}/actions/artifacts/${coverageArtifact.id}/zip`,
      { headers, signal: opts?.signal },
    );
    if (!zipResp.ok) return [];
    zipBuffer = Buffer.from(await zipResp.arrayBuffer());
  } catch {
    return [];
  }

  // Parse the first recognised coverage file inside the ZIP.
  const zipEntries = readZipEntries(zipBuffer);
  let coverageMap: CoverageMap | null = null;
  for (const entry of zipEntries) {
    const kind = coverageFileKind(entry.name);
    if (!kind) continue;
    const parsed = parseCoverage(kind, entry.data.toString("utf-8"));
    if (parsed.size > 0) { coverageMap = parsed; break; }
  }
  if (!coverageMap) return [];

  // Correlate changed lines with uncovered lines.
  const findings: CoverageDeltaFinding[] = [];
  for (const [prFile, prLines] of changedLines) {
    if (findings.length >= MAX_FILES_REPORTED) break;

    let uncoveredForFile: Set<number> | null = null;
    for (const [covPath, uncovered] of coverageMap) {
      if (pathMatches(covPath, prFile)) { uncoveredForFile = uncovered; break; }
    }
    if (!uncoveredForFile) continue;

    const uncoveredChanged: number[] = [];
    for (const line of prLines) {
      if (uncoveredForFile.has(line)) uncoveredChanged.push(line);
      if (uncoveredChanged.length >= MAX_LINES_PER_FILE) break;
    }
    if (uncoveredChanged.length === 0) continue;

    uncoveredChanged.sort((a, b) => a - b);
    findings.push({ file: prFile, uncoveredLines: uncoveredChanged });
  }

  return findings;
}
