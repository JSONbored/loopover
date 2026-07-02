// Dependency-diff + OSV.dev CVE analyzer (#1474). Parses the changed manifests in the PR diff for added/upgraded
// dependencies, then queries OSV.dev (free, no key) for known vulnerabilities in the NEW versions. This is the
// heavy/external work the no-checkout `claude --print` reviewer cannot do (Bash/WebFetch disallowed, no CVE DB).
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  DependencyFinding,
  Cve,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

export interface DepChange {
  ecosystem: string;
  package: string;
  from: string | null;
  to: string;
}

const MAX_MANIFEST_FILES = 20;
const MAX_PATCH_LINES_PER_FILE = 500;
const MAX_DEPENDENCY_QUERIES = 25;
const OSV_QUERY_BATCH_SIZE = 10;
const OSV_QUERY_MAX_BYTES = 512 * 1024;
const OSV_QUERY_BATCH_MAX_BYTES = 1024 * 1024;

export interface ScanLimits {
  maxManifestFiles?: number;
  maxPatchLinesPerFile?: number;
  maxDependencyQueries?: number;
}

type ExternalFetchContext = Pick<AnalysisContext, "fetchJson">;

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
  analysis?: ExternalFetchContext;
  diagnostics?: AnalyzerDiagnostics;
}

// Per-manifest line parsers. Each returns [name, version] for a `+`/`-` diff line, or null. Heuristic (line-based,
// not a full manifest parse) — good enough to flag the deps a PR adds/bumps without resolving the whole tree.
const NPM_RE = /^"([^"]+)"\s*:\s*"([^"]+)"/;
const NPM_ALIAS_RE = /^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/;
const NPM_VERSION_PREFIX_RE = /^[\^~>=<\s]+/;
// The optional `[extras]` group (PEP 508 — requests[security], uvicorn[standard], celery[redis,auth])
// must be consumed but not captured: OSV.dev keys PyPI by the base project name, and a class that
// stopped at `[` silently dropped every pinned-with-extras dependency from the CVE scan.
const PYPI_RE =
  /^([A-Za-z0-9._-]+)(?:\[[A-Za-z0-9._,\s-]+\])?\s*==\s*([0-9][^\s;]*)/;
// Go module paths are case-sensitive and the element grammar admits A-Z plus the full
// punctuation set Go allows (`. _ ~ -`, per golang.org/x/mod/module modPathOK), not just `.`/`-`.
// A narrower class silently drops uppercase or `_`/`~` paths (github.com/BurntSushi/toml,
// github.com/foo_bar/baz, golang.org/x/~exp) from every dependency-fed scanner (CVE, license,
// provenance, native-build). The class stays strictly more permissive, so lowercase paths are
// unaffected, and the case-sensitive name is preserved verbatim for the OSV lookup.
const GO_RE = /^([A-Za-z0-9._~\/-]+)\s+v([0-9][^\s]*)/;

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
        line.startsWith("+++ ") ||
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

export function fixedOf(vuln: OsvVuln): string | null {
  const fixes = new Set<string>();
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) fixes.add(event.fixed);
      }
    }
  }
  // Report a fixed version only when it is UNAMBIGUOUS. A CVE with multiple version-lines patched separately
  // (e.g. fixed in `1.5.0` for the 1.x line AND `2.3.0` for the 2.x line) exposes more than one `fixed` version;
  // returning the first would tell a 2.x user to "upgrade" to `1.5.0`, which does not fix their line. Without
  // per-range version matching we cannot pick the right one, so report none rather than a wrong remediation.
  const list = [...fixes];
  return list.length === 1 ? list[0]! : null;
}

function mapOsvVulns(vulns: OsvVuln[] | undefined): Cve[] {
  return (vulns ?? []).map((vuln) => ({
    id: vuln.id,
    severity: severityOf(vuln),
    summary: (vuln.summary ?? vuln.details ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 180),
    fixedIn: fixedOf(vuln),
  }));
}

async function fetchOsvDirect(
  ecosystem: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics" | "limits"> = {},
): Promise<Cve[]> {
  if (signal?.aborted) return [];
  const fetchOptions = {
    endpointCategory: "osv-query",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ package: { name, ecosystem }, version }),
    signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "dependency",
    subcall: "osv-query",
    maxBytes: OSV_QUERY_MAX_BYTES,
    maxCallsPerCategory:
      options.limits?.maxDependencyQueries ?? MAX_DEPENDENCY_QUERIES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<{ vulns?: OsvVuln[] }>(
        "https://api.osv.dev/v1/query",
        fetchOptions,
      )
    : await boundedFetchJson<{ vulns?: OsvVuln[] }>(
        "https://api.osv.dev/v1/query",
        fetchOptions,
      );
  if (!response.ok) return [];
  return mapOsvVulns(response.data.vulns);
}

/* Legacy direct path kept for tests and injected callers that do not have request context. */
async function queryOsvDirect(
  ecosystem: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  diagnostics?: AnalyzerDiagnostics,
): Promise<Cve[]> {
  return fetchOsvDirect(ecosystem, name, version, fetchImpl, signal, {
    diagnostics,
  });
}

/*
 * queryOsv remains exported for existing direct unit tests. It intentionally delegates to the bounded direct path
 * so even injected callers get timeout, byte-cap, and safe diagnostic behavior without request-cache context.
 */
export async function queryOsv(
  ecosystem: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  diagnostics?: AnalyzerDiagnostics,
): Promise<Cve[]> {
  return queryOsvDirect(ecosystem, name, version, fetchImpl, signal, diagnostics);
}

function osvCacheKey(change: DepChange): string {
  return `${change.ecosystem}:${change.package}:${change.to}`;
}

/** Batch-query OSV.dev for direct dependency changes. Best-effort: returns empty CVE arrays on any failure. */
export async function queryOsvBatch(
  changes: readonly DepChange[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics" | "limits"> = {},
): Promise<Map<string, Cve[]>> {
  const results = new Map<string, Cve[]>();
  if (!changes.length || signal?.aborted) return results;

  const boundedChanges = changes.slice(
    0,
    options.limits?.maxDependencyQueries ?? MAX_DEPENDENCY_QUERIES,
  );
  const uniqueChanges: DepChange[] = [];
  const seen = new Set<string>();
  for (const change of boundedChanges) {
    const key = osvCacheKey(change);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueChanges.push(change);
  }

  const maxBatchCalls = Math.ceil(uniqueChanges.length / OSV_QUERY_BATCH_SIZE);
  for (let i = 0; i < uniqueChanges.length; i += OSV_QUERY_BATCH_SIZE) {
    if (signal?.aborted) break;
    const chunk = uniqueChanges.slice(i, i + OSV_QUERY_BATCH_SIZE);
    const fetchOptions = {
      endpointCategory: "osv-direct-querybatch",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: chunk.map((change) => ({
          package: { name: change.package, ecosystem: change.ecosystem },
          version: change.to,
        })),
      }),
      signal,
      fetchImpl,
      diagnostics: options.diagnostics,
      phase: "dependency",
      subcall: "osv-direct-querybatch",
      maxBytes: OSV_QUERY_BATCH_MAX_BYTES,
      maxCallsPerCategory: maxBatchCalls,
    };
    const response = options.analysis
      ? await options.analysis.fetchJson<{
          results?: Array<{ vulns?: OsvVuln[] }>;
        }>("https://api.osv.dev/v1/querybatch", fetchOptions)
      : await boundedFetchJson<{
          results?: Array<{ vulns?: OsvVuln[] }>;
        }>("https://api.osv.dev/v1/querybatch", fetchOptions);

    if (!response.ok) {
      for (const change of chunk) {
        const cves = await fetchOsvDirect(
          change.ecosystem,
          change.package,
          change.to,
          fetchImpl,
          signal,
          options,
        );
        results.set(osvCacheKey(change), cves);
      }
      continue;
    }

    chunk.forEach((change, index) => {
      results.set(
        osvCacheKey(change),
        mapOsvVulns(response.data.results?.[index]?.vulns),
      );
    });
  }
  return results;
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
  const cvesByKey = await queryOsvBatch(
    boundedChanges,
    fetchImpl,
    options.signal,
    options,
  );
  const findings: DependencyFinding[] = [];
  for (const change of boundedChanges) {
    if (options.signal?.aborted) break;
    const cves = cvesByKey.get(osvCacheKey(change)) ?? [];
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
