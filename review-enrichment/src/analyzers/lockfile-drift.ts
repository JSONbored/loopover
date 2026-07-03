// Lockfile drift + OSV.dev analyzer (#1502). Detects vulnerable package versions introduced only through
// lockfile changes, where the top-level manifest diff does not name the package. This catches transitive pins and
// downgraded resolved versions that the manifest-only dependency analyzer cannot see.
import type {
  AnalyzerDiagnostics,
  Cve,
  EnrichRequest,
  LockfileDriftFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { boundedFetchJson } from "../external-fetch.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";
import { isParseableLockfile, lockfileBasename } from "../lockfile-path.js";

interface LockfileChange {
  file: string;
  line: number;
  ecosystem: "npm" | "PyPI";
  package: string;
  from: string | null;
  to: string;
}

interface ScanLimits {
  maxLockfileFiles?: number;
  maxPatchLinesPerFile?: number;
  maxOsvQueries?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface PatchLine {
  sign: "+" | "-" | " ";
  content: string;
  newLine: number;
}

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }>;
}

const MAX_LOCKFILE_FILES = 12;
const MAX_PATCH_LINES_PER_FILE = 1200;
const MAX_OSV_QUERIES = 40;
const VERSION_SAFE_RE = /^[0-9][0-9A-Za-z._+-]*$/;
const MAX_PACKAGE_LEN = 200;
const MAX_VERSION_LEN = 100;
const PACKAGE_LOCK_CONTAINER_KEYS = new Set(["", "packages", "dependencies"]);

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

function toCves(vulns: OsvVuln[] | undefined): Cve[] {
  return (vulns ?? []).map((vuln) => ({
    id: vuln.id,
    severity: severityOf(vuln),
    summary: (vuln.summary ?? vuln.details ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 180),
    fixedIn: fixedOf(vuln),
  }));
}

function isSafeQuery(pkg: string, version: string): boolean {
  return (
    pkg.length > 0 &&
    pkg.length <= MAX_PACKAGE_LEN &&
    version.length > 0 &&
    version.length <= MAX_VERSION_LEN &&
    VERSION_SAFE_RE.test(version)
  );
}

function* patchLines(
  patch: string,
  maxLines: number,
): Generator<PatchLine> {
  let newLine = 0;
  let seen = 0;
  for (const raw of patch.split("\n")) {
    seen += 1;
    if (seen > maxLines) break;
    if (isDiffFileHeaderLine(raw)) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    const first = raw[0];
    if (first === "+") {
      yield { sign: "+", content: raw.slice(1), newLine };
      newLine += 1;
    } else if (first === "-") {
      yield { sign: "-", content: raw.slice(1), newLine };
    } else {
      yield { sign: " ", content: raw.slice(1), newLine };
      newLine += 1;
    }
  }
}

function npmPackageFromNodeModulesPath(path: string): string | null {
  const marker = "node_modules/";
  const i = path.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = path.slice(i + marker.length);
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return null;
  }
  return rest.split("/")[0] || null;
}

function parsePackageLock(path: string, patch: string, maxLines: number): LockfileChange[] {
  const byKey = new Map<string, LockfileChange>();
  let currentPackage: string | null = null;
  let sawPackagesEntry = false;
  for (const line of patchLines(patch, maxLines)) {
    const body = line.content.trim();
    const objectHeader = /^"([^"]+)"\s*:\s*\{/.exec(body);
    if (objectHeader) {
      const key = objectHeader[1]!;
      const packageName = npmPackageFromNodeModulesPath(key);
      if (packageName) {
        currentPackage = packageName;
        sawPackagesEntry = true;
      } else if (!sawPackagesEntry && !PACKAGE_LOCK_CONTAINER_KEYS.has(key)) {
        currentPackage = key;
      } else {
        currentPackage = null;
      }
      continue;
    }
    if (body === "}" || body.startsWith("},")) currentPackage = null;
    if (!currentPackage) continue;
    const versionMatch = /^"version"\s*:\s*"([^"]+)"/.exec(body);
    if (!versionMatch) continue;
    const version = versionMatch[1]!;
    const key = `npm::${currentPackage}`;
    const entry =
      byKey.get(key) ??
      {
        file: path,
        line: line.newLine,
        ecosystem: "npm" as const,
        package: currentPackage,
        from: null,
        to: "",
      };
    if (line.sign === "+") {
      entry.to = version;
      entry.line = line.newLine;
    } else if (line.sign === "-") {
      entry.from = version;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((change) => change.to && change.to !== change.from);
}

function yarnPackageFromDescriptor(descriptor: string): string | null {
  const cleaned = descriptor.trim().replace(/^["']|["']$/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("@")) {
    const slash = cleaned.indexOf("/");
    if (slash < 0) return null;
    const rangeAt = cleaned.indexOf("@", slash + 1);
    return rangeAt < 0 ? cleaned : cleaned.slice(0, rangeAt);
  }
  const at = cleaned.indexOf("@");
  return at < 0 ? cleaned : cleaned.slice(0, at);
}

function splitYarnDescriptors(header: string): string[] {
  const descriptors: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of header) {
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      current += char;
      continue;
    }
    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }
    if (char === "," && quote === null) {
      const descriptor = current.trim();
      if (descriptor) descriptors.push(descriptor);
      current = "";
      continue;
    }
    current += char;
  }
  const descriptor = current.trim();
  if (descriptor) descriptors.push(descriptor);
  return descriptors;
}

function parseYarnLock(path: string, patch: string, maxLines: number): LockfileChange[] {
  const byKey = new Map<string, LockfileChange>();
  let currentPackages: string[] = [];
  for (const line of patchLines(patch, maxLines)) {
    if (line.content && !line.content.startsWith("#") && !/^\s/.test(line.content)) {
      if (!line.content.trim().endsWith(":")) {
        currentPackages = [];
        continue;
      }
      const header = line.content.trim().replace(/:$/, "");
      currentPackages = [
        ...new Set(
          splitYarnDescriptors(header)
            .map((descriptor) => yarnPackageFromDescriptor(descriptor))
            .filter((pkg): pkg is string => Boolean(pkg)),
        ),
      ];
      continue;
    }
    if (!currentPackages.length) continue;
    const versionMatch =
      /^\s+version\s+"([^"]+)"/.exec(line.content) ??
      /^\s+version:\s*"?([^"\s#]+)"?/.exec(line.content);
    if (!versionMatch) continue;
    const version = versionMatch[1]!;
    for (const currentPackage of currentPackages) {
      const key = `npm::${currentPackage}`;
      const entry =
        byKey.get(key) ??
        {
          file: path,
          line: line.newLine,
          ecosystem: "npm" as const,
          package: currentPackage,
          from: null,
          to: "",
        };
      if (line.sign === "+") {
        entry.to = version;
        entry.line = line.newLine;
      } else if (line.sign === "-") {
        entry.from = version;
      }
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].filter((change) => change.to && change.to !== change.from);
}

function parsePoetryLock(path: string, patch: string, maxLines: number): LockfileChange[] {
  const byKey = new Map<string, LockfileChange>();
  let currentPackage: string | null = null;
  for (const line of patchLines(patch, maxLines)) {
    const body = line.content.trim();
    if (body === "[[package]]") {
      currentPackage = null;
      continue;
    }
    const nameMatch = /^name\s*=\s*"([^"]+)"/.exec(body);
    if (nameMatch) {
      currentPackage = nameMatch[1]!;
      continue;
    }
    if (!currentPackage) continue;
    const versionMatch = /^version\s*=\s*"([^"]+)"/.exec(body);
    if (!versionMatch) continue;
    const version = versionMatch[1]!;
    const key = `PyPI::${currentPackage}`;
    const entry =
      byKey.get(key) ??
      {
        file: path,
        line: line.newLine,
        ecosystem: "PyPI" as const,
        package: currentPackage,
        from: null,
        to: "",
      };
    if (line.sign === "+") {
      entry.to = version;
      entry.line = line.newLine;
    } else if (line.sign === "-") {
      entry.from = version;
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()].filter((change) => change.to && change.to !== change.from);
}

function parseLockfile(path: string, patch: string, maxLines: number): LockfileChange[] {
  const name = lockfileBasename(path).toLowerCase();
  if (name === "package-lock.json") return parsePackageLock(path, patch, maxLines);
  if (name === "yarn.lock") return parseYarnLock(path, patch, maxLines);
  if (name === "poetry.lock") return parsePoetryLock(path, patch, maxLines);
  return [];
}

/** Extract lockfile-only resolved package changes. Top-level manifest changes are excluded as direct deps. */
export function extractLockfileChanges(
  files: NonNullable<EnrichRequest["files"]>,
  limits: ScanLimits = {},
): LockfileChange[] {
  const direct = new Set(
    extractDependencyChanges(files).map((dep) => `${dep.ecosystem}::${dep.package}`),
  );
  const maxFiles = limits.maxLockfileFiles ?? MAX_LOCKFILE_FILES;
  const maxLines = limits.maxPatchLinesPerFile ?? MAX_PATCH_LINES_PER_FILE;
  const changes: LockfileChange[] = [];
  let scannedFiles = 0;
  for (const file of files) {
    if (!file.patch || !isParseableLockfile(file.path)) continue;
    scannedFiles += 1;
    if (scannedFiles > maxFiles) break;
    for (const change of parseLockfile(file.path, file.patch, maxLines)) {
      if (direct.has(`${change.ecosystem}::${change.package}`)) continue;
      if (!isSafeQuery(change.package, change.to)) continue;
      changes.push(change);
    }
  }
  return changes;
}

/** Batch-query OSV.dev for lockfile resolutions. Best-effort: returns empty CVE arrays on any failure. */
export async function queryOsvBatch(
  changes: LockfileChange[],
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics" | "limits"> = {},
): Promise<Map<string, Cve[]>> {
  const results = new Map<string, Cve[]>();
  if (!changes.length || signal?.aborted) return results;
  const fetchOptions = {
    endpointCategory: "osv-querybatch",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: changes.map((change) => ({
        package: { name: change.package, ecosystem: change.ecosystem },
        version: change.to,
      })),
    }),
    signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "lockfile-drift",
    subcall: "osv-querybatch",
    maxBytes: 1024 * 1024,
    maxCallsPerCategory: 1,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<{
        results?: Array<{ vulns?: OsvVuln[] }>;
      }>("https://api.osv.dev/v1/querybatch", fetchOptions)
    : await boundedFetchJson<{
      results?: Array<{ vulns?: OsvVuln[] }>;
    }>("https://api.osv.dev/v1/querybatch", fetchOptions);
  if (!response.ok) return results;
  changes.forEach((change, index) => {
    results.set(
      `${change.ecosystem}::${change.package}@${change.to}`,
      toCves(response.data.results?.[index]?.vulns),
    );
  });
  return results;
}

/** Analyzer entrypoint: lockfile-only resolved deps → OSV → vulnerable transitive drift findings. */
export async function scanLockfileDrift(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<LockfileDriftFinding[]> {
  const changes = extractLockfileChanges(req.files ?? [], options.limits).slice(
    0,
    options.limits?.maxOsvQueries ?? MAX_OSV_QUERIES,
  );
  const cvesByKey = await queryOsvBatch(changes, fetchImpl, options.signal, options);
  const findings: LockfileDriftFinding[] = [];
  for (const change of changes) {
    const cves = cvesByKey.get(`${change.ecosystem}::${change.package}@${change.to}`) ?? [];
    if (!cves.length) continue;
    findings.push({
      ...change,
      direction: change.from ? "change" : "add",
      cves,
    });
  }
  return findings;
}
