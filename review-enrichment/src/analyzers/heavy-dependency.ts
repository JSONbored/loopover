// Heavy-dependency-for-trivial-use analyzer (#1505). For each newly-added/upgraded npm dependency, count direct
// import/require usage in the PR's added lines and fetch package weight metadata. Flag only when the package is
// both materially heavy and used trivially, so the review brief can ask whether a local helper/native API would do.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  HeavyDependencyFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { isDiffFileHeaderLine } from "./diff-lines.js";
import { boundedFetchJson } from "../external-fetch.js";

const MAX_WEIGHT_LOOKUPS = 20;
const MAX_FINDINGS = 15;
const TRIVIAL_USAGE_MAX = 2;
const MIN_INSTALL_BYTES = 500_000;
const MIN_BUNDLE_BYTES = 80_000;
const MIN_GZIP_BYTES = 25_000;
const MAX_NPM_PACKAGE_NAME_CHARS = 214;
const MAX_NPM_PACKAGE_VERSION_CHARS = 256;

// In-process TTL cache for bundlephobia size results. Keyed by "pkg@version".
// Caching prevents redundant calls that would exhaust bundlephobia's rate limit
// when multiple enrichment requests look up the same package spec.
const WEIGHT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
// Bounded so a long-lived process scanning many distinct pkg@version specs across PRs
// can't grow this cache without limit (the key is attacker-influenced via manifest diffs).
const MAX_WEIGHT_CACHE_ENTRIES = 1000;
interface WeightCacheEntry {
  value: PackageWeight | null;
  expiresAt: number;
}
const weightCache = new Map<string, WeightCacheEntry>();

export function resetWeightCacheForTest(): void {
  weightCache.clear();
}

export function weightCacheSizeForTest(): number {
  return weightCache.size;
}

function setWeightCache(cacheKey: string, entry: WeightCacheEntry): void {
  if (weightCache.size >= MAX_WEIGHT_CACHE_ENTRIES && !weightCache.has(cacheKey)) {
    const now = Date.now();
    for (const [key, existing] of weightCache) {
      if (existing.expiresAt <= now) weightCache.delete(key);
    }
    while (weightCache.size >= MAX_WEIGHT_CACHE_ENTRIES) {
      const oldestKey = weightCache.keys().next().value;
      if (oldestKey === undefined) break;
      weightCache.delete(oldestKey);
    }
  }
  weightCache.set(cacheKey, entry);
}

const NPM_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface PackageWeight {
  installSizeBytes: number | null;
  bundleSizeBytes: number | null;
  gzipSizeBytes: number | null;
  dependencyCount: number | null;
}

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

function isSafeNpmPackageVersion(name: string, version: string): boolean {
  return (
    name.length <= MAX_NPM_PACKAGE_NAME_CHARS &&
    version.length <= MAX_NPM_PACKAGE_VERSION_CHARS &&
    NPM_PACKAGE_RE.test(name) &&
    SEMVER_RE.test(version)
  );
}

function addedPatchLines(
  files: NonNullable<EnrichRequest["files"]>,
): AddedLine[] {
  const lines: AddedLine[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    let nextLine = 0;
    for (const raw of file.patch.split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        nextLine = Number(hunk[1]);
        continue;
      }
      if (raw.startsWith("\\ No newline")) continue;
      // Skip real file headers (`+++ b/…`) but scan added CONTENT that begins with `++` (rendered `+++x`/`+++ x`).
      if (raw.startsWith("+") && !isDiffFileHeaderLine(raw)) {
        lines.push({
          file: file.path,
          line: nextLine || 1,
          text: raw.slice(1),
        });
        nextLine += 1;
        continue;
      }
      if (raw.startsWith("-") && !isDiffFileHeaderLine(raw)) continue;
      if (nextLine) nextLine += 1;
    }
  }
  return lines;
}

function moduleSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const callOrFrom =
    /(?:from\s*|require\s*\(\s*|import\s*\(\s*)["']([^"']+)["']/g;
  for (const match of text.matchAll(callOrFrom)) {
    if (match[1]) specs.push(match[1]);
  }
  const sideEffect = /^\s*import\s+["']([^"']+)["']/.exec(text);
  if (sideEffect?.[1]) specs.push(sideEffect[1]);
  return specs;
}

function packageNameFromSpecifier(specifier: string): string | null {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/", 3);
    return scope && name ? `${scope}/${name}` : null;
  }
  const [name] = specifier.split("/", 1);
  return name || null;
}

function countPatchUsagesByPackage(
  files: NonNullable<EnrichRequest["files"]>,
  packages: ReadonlySet<string>,
): Map<string, Pick<HeavyDependencyFinding, "usageCount" | "usageLocations">> {
  const usages = new Map<
    string,
    Pick<HeavyDependencyFinding, "usageCount" | "usageLocations">
  >();
  for (const line of addedPatchLines(files)) {
    for (const specifier of moduleSpecifiers(line.text)) {
      const pkg = packageNameFromSpecifier(specifier);
      if (!pkg || !packages.has(pkg)) continue;
      const usage = usages.get(pkg) ?? { usageCount: 0, usageLocations: [] };
      usage.usageCount += 1;
      if (usage.usageLocations.length < TRIVIAL_USAGE_MAX) {
        usage.usageLocations.push({ file: line.file, line: line.line });
      }
      usages.set(pkg, usage);
    }
  }
  return usages;
}

export function countPackagePatchUsages(
  files: NonNullable<EnrichRequest["files"]>,
  pkg: string,
): Pick<HeavyDependencyFinding, "usageCount" | "usageLocations"> {
  return (
    countPatchUsagesByPackage(files, new Set([pkg])).get(pkg) ?? {
      usageCount: 0,
      usageLocations: [],
    }
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function queryPackageWeight(
  pkg: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  options: Pick<ScanOptions, "analysis" | "diagnostics"> = {},
): Promise<PackageWeight | null> {
  if (signal?.aborted) return null;
  if (!isSafeNpmPackageVersion(pkg, version)) return null;

  const cacheKey = `${pkg}@${version}`;
  const cached = weightCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  try {
    const packageSpec = encodeURIComponent(`${pkg}@${version}`);
    const url = `https://bundlephobia.com/api/size?package=${packageSpec}`;
    const fetchOptions = {
      endpointCategory: "bundlephobia-size",
      signal,
      fetchImpl,
      diagnostics: options.diagnostics,
      phase: "heavy-dependency",
      subcall: "bundlephobia-size",
      maxBytes: 256 * 1024,
      maxCallsPerCategory: MAX_WEIGHT_LOOKUPS,
    };
    const response = options.analysis
      ? await options.analysis.fetchJson<{
          installSize?: unknown;
          size?: unknown;
          gzip?: unknown;
          dependencyCount?: unknown;
        }>(url, fetchOptions)
      : await boundedFetchJson<{
          installSize?: unknown;
          size?: unknown;
          gzip?: unknown;
          dependencyCount?: unknown;
        }>(url, fetchOptions);
    if (!response.ok) {
      // Only cache definitive HTTP responses (e.g. 404 not found, 429 rate-limited).
      // Do not cache transient failures (timeout, network_error, aborted, circuit_open,
      // call_cap) — those should be retried on the next enrichment request.
      if (response.reason === "http_error") {
        setWeightCache(cacheKey, { value: null, expiresAt: Date.now() + WEIGHT_CACHE_TTL_MS });
      }
      return null;
    }
    const data = response.data;
    const result: PackageWeight = {
      installSizeBytes: numberOrNull(data.installSize),
      bundleSizeBytes: numberOrNull(data.size),
      gzipSizeBytes: numberOrNull(data.gzip),
      dependencyCount: numberOrNull(data.dependencyCount),
    };
    setWeightCache(cacheKey, { value: result, expiresAt: Date.now() + WEIGHT_CACHE_TTL_MS });
    return result;
  } catch {
    return null;
  }
}

export function isHeavyPackageWeight(weight: PackageWeight): boolean {
  return (
    (weight.installSizeBytes ?? 0) >= MIN_INSTALL_BYTES ||
    (weight.bundleSizeBytes ?? 0) >= MIN_BUNDLE_BYTES ||
    (weight.gzipSizeBytes ?? 0) >= MIN_GZIP_BYTES
  );
}

export async function scanHeavyDependencies(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<HeavyDependencyFinding[]> {
  const findings: HeavyDependencyFinding[] = [];
  const changes = extractDependencyChanges(req.files ?? []).filter(
    (change) => change.ecosystem === "npm",
  );
  const safePackageNames = new Set(
    changes
      .filter((change) => isSafeNpmPackageVersion(change.package, change.to))
      .map((change) => change.package),
  );
  const usagesByPackage = countPatchUsagesByPackage(
    req.files ?? [],
    safePackageNames,
  );
  let weightLookups = 0;

  for (const change of changes) {
    if (options.signal?.aborted || findings.length >= MAX_FINDINGS) break;
    if (!isSafeNpmPackageVersion(change.package, change.to)) continue;

    const usage = usagesByPackage.get(change.package) ?? {
      usageCount: 0,
      usageLocations: [],
    };
    if (usage.usageCount < 1 || usage.usageCount > TRIVIAL_USAGE_MAX) continue;
    if (weightLookups >= MAX_WEIGHT_LOOKUPS) break;
    weightLookups += 1;

    const weight = await queryPackageWeight(
      change.package,
      change.to,
      fetchImpl,
      options.signal,
      options,
    );
    if (!weight || !isHeavyPackageWeight(weight)) continue;

    findings.push({
      ecosystem: "npm",
      package: change.package,
      version: change.to,
      from: change.from,
      direction: change.from ? "change" : "add",
      usageCount: usage.usageCount,
      usageLocations: usage.usageLocations,
      ...weight,
    });
  }

  return findings;
}
