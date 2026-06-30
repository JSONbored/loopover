// Dependency-diff + OSV.dev CVE analyzer (#1474). Parses the changed manifests in the PR diff for added/upgraded
// dependencies, then queries OSV.dev (free, no key) for known vulnerabilities in the NEW versions. This is the
// heavy/external work the no-checkout `claude --print` reviewer cannot do (Bash/WebFetch disallowed, no CVE DB).
import type { EnrichRequest, DependencyFinding, Cve } from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";

export interface DepChange {
  ecosystem: string;
  package: string;
  from: string | null;
  to: string;
}

const MAX_MANIFEST_FILES = 20;
const MAX_PATCH_LINES_PER_FILE = 500;
const MAX_DEPENDENCY_QUERIES = 25;

export interface ScanLimits {
  maxManifestFiles?: number;
  maxPatchLinesPerFile?: number;
  maxDependencyQueries?: number;
}

type ExternalCallCache = Pick<AnalysisContext, "cachedExternalCall">;

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
  cache?: ExternalCallCache;
}

// Per-manifest line parsers. Each returns [name, version] for a `+`/`-` diff line, or null. Heuristic (line-based,
// not a full manifest parse) — good enough to flag the deps a PR adds/bumps without resolving the whole tree.
const NPM_RE = /^"([^"]+)"\s*:\s*"([^"]+)"/;
const NPM_ALIAS_RE = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/;
const NPM_VERSION_PREFIX_RE = /^[\^~>=<\s]+/;
const PYPI_RE = /^([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;]*)/;
const GO_RE = /^([a-z0-9.\/-]+)\s+v([0-9][^\s]*)/;

function parseLine(
  manifest: string,
  body: string,
): { name: string; version: string } | null {
  if (manifest === "package.json") {
    const m = NPM_RE.exec(body);
    if (m) {
      const spec = m[2]!.trim();
      const alias = NPM_ALIAS_RE.exec(spec);
      if (alias) return { name: alias[1]!, version: alias[2]!.replace(NPM_VERSION_PREFIX_RE, "").trim() };
      if (/^[\^~>=<\s]*[0-9]/.test(spec))
        return { name: m[1]!, version: spec.replace(NPM_VERSION_PREFIX_RE, "").trim() };
    }
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
    if (manifestFiles > maxManifestFiles) break;
    for (const line of file.patch.split("\n", maxPatchLinesPerFile)) {
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

function osvCacheKey(change: DepChange): string {
  return `${change.ecosystem}:${change.package}:${change.to}`;
}

async function queryOsvForChange(
  change: DepChange,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<Cve[]> {
  const load = () =>
    queryOsv(
      change.ecosystem,
      change.package,
      change.to,
      fetchImpl,
      options.signal,
    );
  return options.cache
    ? options.cache.cachedExternalCall("osv", osvCacheKey(change), load)
    : load();
}

/** Scan already-extracted dependency changes → OSV → only the deps that carry vulnerabilities. */
export async function scanDependencyChanges(
  changes: readonly DepChange[],
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DependencyFinding[]> {
  const boundedChanges = changes.slice(
    0,
    options.limits?.maxDependencyQueries ?? MAX_DEPENDENCY_QUERIES,
  );
  const findings: DependencyFinding[] = [];
  for (const change of boundedChanges) {
    if (options.signal?.aborted) break;
    const cves = await queryOsvForChange(change, fetchImpl, options);
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

/** Analyzer entrypoint: changed deps → OSV → only the deps that carry vulnerabilities. */
export async function scanDependencies(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DependencyFinding[]> {
  return scanDependencyChanges(
    extractDependencyChanges(req.files ?? [], options.limits),
    fetchImpl,
    options,
  );
}
