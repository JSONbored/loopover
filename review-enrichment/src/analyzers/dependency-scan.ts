// Dependency-diff + OSV.dev CVE analyzer (#1474). Parses the changed manifests in the PR diff for added/upgraded
// dependencies, then queries OSV.dev (free, no key) for known vulnerabilities in the NEW versions. This is the
// heavy/external work the no-checkout `claude --print` reviewer cannot do (Bash/WebFetch disallowed, no CVE DB).
import type { EnrichRequest, DependencyFinding, Cve } from "../types.js";

interface DepChange {
  ecosystem: string;
  package: string;
  from: string | null;
  to: string;
}

const MAX_MANIFEST_FILES = 20;
const MAX_PATCH_LINES_PER_FILE = 500;
const MAX_DEPENDENCY_QUERIES = 25;

interface ScanLimits {
  maxManifestFiles?: number;
  maxPatchLinesPerFile?: number;
  maxDependencyQueries?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

export class DependencyScanTruncatedError extends Error {
  constructor(reason: string) {
    super(`dependency_scan_truncated:${reason}`);
    this.name = "DependencyScanTruncatedError";
  }
}

// Per-manifest line parsers. Each returns [name, version] for a `+`/`-` diff line, or null. Heuristic (line-based,
// not a full manifest parse) — good enough to flag the deps a PR adds/bumps without resolving the whole tree.
const NPM_RE = /^"([^"]+)"\s*:\s*"([\^~>=<\s]*[0-9][^"]*)"/;
const PYPI_RE = /^([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;]*)/;
const GO_RE = /^([a-z0-9.\/-]+)\s+v([0-9][^\s]*)/;

function parseLine(
  manifest: string,
  body: string,
): { name: string; version: string } | null {
  if (manifest === "package.json") {
    const m = NPM_RE.exec(body);
    if (m)
      return { name: m[1]!, version: m[2]!.replace(/^[\^~>=<\s]+/, "").trim() };
  } else if (manifest === "requirements.txt") {
    const m = PYPI_RE.exec(body);
    if (m) return { name: m[1]!, version: m[2]! };
  } else if (manifest === "go.mod") {
    const m = GO_RE.exec(body.replace(/^require\s+/, "").trim());
    if (m) return { name: m[1]!, version: m[2]! };
  }
  return null;
}

const ECOSYSTEM: Record<string, string> = {
  "package.json": "npm",
  "requirements.txt": "PyPI",
  "go.mod": "Go",
};

/** Extract added/changed (not removed) dependency versions from the changed manifests in the diff. Pure. */
export function extractDependencyChanges(
  files: NonNullable<EnrichRequest["files"]>,
  limits: ScanLimits = {},
): DepChange[] {
  const byKey = new Map<
    string,
    { ecosystem: string; package: string; added?: string; removed?: string }
  >();
  const maxManifestFiles = limits.maxManifestFiles ?? MAX_MANIFEST_FILES;
  const maxPatchLinesPerFile =
    limits.maxPatchLinesPerFile ?? MAX_PATCH_LINES_PER_FILE;
  let manifestFiles = 0;
  for (const file of files) {
    const manifest = file.path.split("/").pop() ?? file.path;
    const ecosystem = ECOSYSTEM[manifest];
    if (!ecosystem || !file.patch) continue;
    manifestFiles += 1;
    if (manifestFiles > maxManifestFiles)
      throw new DependencyScanTruncatedError("manifest_file_limit");
    const patchLines = file.patch.split("\n");
    if (patchLines.length > maxPatchLinesPerFile)
      throw new DependencyScanTruncatedError("patch_line_limit");
    for (const line of patchLines) {
      const sign = line[0];
      if (
        (sign !== "+" && sign !== "-") ||
        line.startsWith("+++") ||
        line.startsWith("---")
      )
        continue;
      const parsed = parseLine(manifest, line.slice(1).trim());
      if (!parsed) continue;
      const key = ecosystem + "::" + parsed.name;
      const entry = byKey.get(key) ?? { ecosystem, package: parsed.name };
      if (sign === "+") entry.added = parsed.version;
      else entry.removed = parsed.version;
      byKey.set(key, entry);
    }
  }
  const changes: DepChange[] = [];
  for (const entry of byKey.values()) {
    // Only scan a version that's present after the change, and only when it actually changed.
    if (!entry.added || entry.added === entry.removed) continue;
    changes.push({
      ecosystem: entry.ecosystem,
      package: entry.package,
      from: entry.removed ?? null,
      to: entry.added,
    });
  }
  return changes;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
}

function severityOf(vuln: OsvVuln): Cve["severity"] {
  const label = vuln.database_specific?.severity?.toLowerCase();
  if (
    label === "critical" ||
    label === "high" ||
    label === "medium" ||
    label === "low"
  )
    return label;
  const score = Number(
    vuln.severity?.find((s) => s.type?.startsWith("CVSS"))?.score,
  );
  if (!Number.isFinite(score)) return "unknown";
  return score >= 9
    ? "critical"
    : score >= 7
      ? "high"
      : score >= 4
        ? "medium"
        : "low";
}

function fixedOf(vuln: OsvVuln): string | null {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

/** Query OSV.dev for vulnerabilities affecting a specific package version. Best-effort: returns [] on any error. */
export async function queryOsv(
  ecosystem: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<Cve[]> {
  if (signal?.aborted) return [];
  const response = await fetchImpl("https://api.osv.dev/v1/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem }, version }),
    signal,
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { vulns?: OsvVuln[] };
  return (data.vulns ?? []).map((vuln) => ({
    id: vuln.id,
    severity: severityOf(vuln),
    summary: (vuln.summary ?? vuln.details ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 180),
    fixedIn: fixedOf(vuln),
  }));
}

/** Analyzer entrypoint: changed deps → OSV → only the deps that carry vulnerabilities. */
export async function scanDependencies(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DependencyFinding[]> {
  const changes = extractDependencyChanges(req.files ?? [], options.limits);
  const maxDependencyQueries =
    options.limits?.maxDependencyQueries ?? MAX_DEPENDENCY_QUERIES;
  if (changes.length > maxDependencyQueries)
    throw new DependencyScanTruncatedError("dependency_query_limit");
  const findings: DependencyFinding[] = [];
  for (const change of changes) {
    if (options.signal?.aborted) break;
    const cves = await queryOsv(
      change.ecosystem,
      change.package,
      change.to,
      fetchImpl,
      options.signal,
    );
    if (cves.length) {
      findings.push({
        ...change,
        direction: change.from ? "change" : "add",
        cves,
      });
    }
  }
  return findings;
}
