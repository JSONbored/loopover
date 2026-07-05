// Package maintenance-health analyzer (#1511). For each newly-added/upgraded direct npm/PyPI dependency, flag
// factual maintenance-risk signals that are hard for the no-checkout reviewer to verify: deprecated/yanked
// releases, packages with no recent releases, archived upstream projects, or a single maintainer.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  PackageHealthFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { extractDependencyChanges, type DepChange } from "./dependency-scan.js";

const MAX_QUERIES = 25;
const MAX_FINDINGS = 25;
const STALE_DAYS = 730;
const DAY_MS = 86_400_000;
const MAX_NPM_PACKUMENT_BYTES = 2 * 1024 * 1024;
const MAX_PYPI_PROJECT_BYTES = 2 * 1024 * 1024;
const MAX_ECOSYSTEMS_BYTES = 512 * 1024;

const NPM_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,127}$/;

interface ScanLimits {
  maxQueries?: number;
  maxFindings?: number;
  staleDays?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
  now?: number;
}

export interface NpmPackument {
  versions?: Record<string, { deprecated?: string | boolean }>;
  time?: Record<string, string>;
  maintainers?: unknown[];
  users?: Record<string, unknown>;
}

export interface PypiProjectJson {
  info?: {
    version?: string;
    yanked?: boolean;
    yanked_reason?: string | null;
  };
  releases?: Record<
    string,
    Array<{
      upload_time?: string;
      upload_time_iso?: string;
      yanked?: boolean;
      yanked_reason?: string | null;
    }>
  >;
}

export interface EcosystemsPackage {
  archived?: boolean;
  status?: string;
  maintainers_count?: number;
  repository?: {
    archived?: boolean;
    status?: string;
  };
}

interface PackageHealthSignal {
  kind: PackageHealthFinding["kind"];
  details: string;
  lastReleaseAt?: string;
  maintainerCount?: number;
}

function isQueryable(change: DepChange): boolean {
  if (change.ecosystem === "npm")
    return NPM_PACKAGE_RE.test(change.package) && VERSION_RE.test(change.to);
  if (change.ecosystem === "PyPI")
    return PYPI_PACKAGE_RE.test(change.package) && VERSION_RE.test(change.to);
  return false;
}

function ecosystemRegistry(ecosystem: string): string | null {
  if (ecosystem === "npm") return "npmjs.org";
  if (ecosystem === "PyPI") return "pypi.org";
  return null;
}

function parseDateMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function latestDate(values: Iterable<string | undefined>): string | null {
  let best: { value: string; ms: number } | null = null;
  for (const value of values) {
    const ms = parseDateMs(value);
    if (value && ms != null && (!best || ms > best.ms)) best = { value, ms };
  }
  return best?.value ?? null;
}

function daysBetween(now: number, then: string): number | null {
  const ms = parseDateMs(then);
  if (ms == null) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

function staleSignal(
  lastReleaseAt: string | null,
  now: number,
  staleDays: number,
): PackageHealthSignal | null {
  if (!lastReleaseAt) return null;
  const ageDays = daysBetween(now, lastReleaseAt);
  if (ageDays == null || ageDays < staleDays) return null;
  return {
    kind: "stale-release",
    lastReleaseAt,
    details: `latest release is ${ageDays} days old`,
  };
}

function deprecatedSignal(meta: { deprecated?: string | boolean } | undefined): PackageHealthSignal | null {
  if (!meta?.deprecated) return null;
  const text =
    typeof meta.deprecated === "string" && meta.deprecated.trim()
      ? meta.deprecated.replace(/\s+/g, " ").slice(0, 160)
      : "version is deprecated";
  return { kind: "deprecated", details: text };
}

function yankedSignal(project: PypiProjectJson, version: string): PackageHealthSignal | null {
  const releaseFiles = project.releases?.[version] ?? [];
  const yankedFile = releaseFiles.find((file) => file.yanked);
  const infoYanked = project.info?.version === version && project.info.yanked === true;
  if (!yankedFile && !infoYanked) return null;
  const reason =
    yankedFile?.yanked_reason ?? project.info?.yanked_reason ?? "release is yanked";
  return {
    kind: "yanked",
    details: reason ? String(reason).replace(/\s+/g, " ").slice(0, 160) : "release is yanked",
  };
}

function maintainerSignal(count: number | undefined): PackageHealthSignal | null {
  if (count !== 1) return null;
  return {
    kind: "sole-maintainer",
    maintainerCount: count,
    details: "package metadata lists a single maintainer",
  };
}

function archivedSignal(meta: EcosystemsPackage | null): PackageHealthSignal | null {
  if (!meta) return null;
  const archived =
    meta.archived === true ||
    meta.repository?.archived === true ||
    meta.status === "archived" ||
    meta.repository?.status === "archived";
  return archived
    ? { kind: "archived", details: "ecosyste.ms reports the package repository as archived" }
    : null;
}

export function classifyNpmPackageHealth(
  packageName: string,
  version: string,
  packument: NpmPackument | null,
  ecosystems: EcosystemsPackage | null,
  now: number,
  staleDays = STALE_DAYS,
): PackageHealthSignal[] {
  const signals: PackageHealthSignal[] = [];
  const versionMeta = packument?.versions?.[version];
  const deprecated = deprecatedSignal(versionMeta);
  if (deprecated) signals.push(deprecated);

  const latestReleaseAt = latestDate(
    Object.entries(packument?.time ?? {})
      .filter(([key]) => key !== "created" && key !== "modified")
      .map(([, value]) => value),
  );
  const stale = staleSignal(latestReleaseAt, now, staleDays);
  if (stale) signals.push(stale);

  const maintainerCount =
    typeof ecosystems?.maintainers_count === "number"
      ? ecosystems.maintainers_count
      : Array.isArray(packument?.maintainers)
        ? packument.maintainers.length
        : packument?.users
          ? Object.keys(packument.users).length
          : undefined;
  const soleMaintainer = maintainerSignal(maintainerCount);
  if (soleMaintainer) signals.push(soleMaintainer);

  const archived = archivedSignal(ecosystems);
  if (archived) signals.push(archived);

  return signals.map((signal) => ({
    ...signal,
    details: signal.details || `${packageName}@${version} has a maintenance-health signal`,
  }));
}

export function classifyPypiPackageHealth(
  packageName: string,
  version: string,
  project: PypiProjectJson | null,
  ecosystems: EcosystemsPackage | null,
  now: number,
  staleDays = STALE_DAYS,
): PackageHealthSignal[] {
  const signals: PackageHealthSignal[] = [];
  if (project) {
    const yanked = yankedSignal(project, version);
    if (yanked) signals.push(yanked);

    const latestReleaseAt = latestDate(
      Object.values(project.releases ?? {}).flatMap((files) =>
        files.map((file) => file.upload_time_iso ?? file.upload_time),
      ),
    );
    const stale = staleSignal(latestReleaseAt, now, staleDays);
    if (stale) signals.push(stale);
  }

  const soleMaintainer = maintainerSignal(ecosystems?.maintainers_count);
  if (soleMaintainer) signals.push(soleMaintainer);

  const archived = archivedSignal(ecosystems);
  if (archived) signals.push(archived);

  return signals.map((signal) => ({
    ...signal,
    details: signal.details || `${packageName}@${version} has a maintenance-health signal`,
  }));
}

async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch,
  options: ScanOptions,
  endpointCategory: "npm-packument" | "pypi-project" | "ecosystems-package",
  maxBytes: number,
): Promise<T | null> {
  if (options.signal?.aborted) return null;
  const fetchOptions = {
    endpointCategory,
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "package-health",
    subcall: endpointCategory,
    maxBytes,
    maxCallsPerCategory: options.limits?.maxQueries ?? MAX_QUERIES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

function npmPackumentUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
}

function pypiProjectUrl(packageName: string): string {
  return `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;
}

function ecosystemsUrl(change: DepChange): string | null {
  const registry = ecosystemRegistry(change.ecosystem);
  if (!registry) return null;
  return `https://packages.ecosyste.ms/api/v1/registries/${registry}/packages/${encodeURIComponent(change.package)}`;
}

async function scanChange(
  change: DepChange,
  fetchImpl: typeof fetch,
  options: ScanOptions,
): Promise<PackageHealthFinding[]> {
  const ecoUrl = ecosystemsUrl(change);
  const ecosystems = ecoUrl
    ? await fetchJson<EcosystemsPackage>(
        ecoUrl,
        fetchImpl,
        options,
        "ecosystems-package",
        MAX_ECOSYSTEMS_BYTES,
      )
    : null;

  const now = options.now ?? Date.now();
  const staleDays = options.limits?.staleDays ?? STALE_DAYS;
  const signals =
    change.ecosystem === "npm"
      ? classifyNpmPackageHealth(
          change.package,
          change.to,
          await fetchJson<NpmPackument>(
            npmPackumentUrl(change.package),
            fetchImpl,
            options,
            "npm-packument",
            MAX_NPM_PACKUMENT_BYTES,
          ),
          ecosystems,
          now,
          staleDays,
        )
      : classifyPypiPackageHealth(
          change.package,
          change.to,
          await fetchJson<PypiProjectJson>(
            pypiProjectUrl(change.package),
            fetchImpl,
            options,
            "pypi-project",
            MAX_PYPI_PROJECT_BYTES,
          ),
          ecosystems,
          now,
          staleDays,
        );

  return signals.map((signal) => ({
    ecosystem: change.ecosystem as "npm" | "PyPI",
    package: change.package,
    version: change.to,
    from: change.from,
    direction: change.from ? "change" : "add",
    kind: signal.kind,
    details: signal.details,
    lastReleaseAt: signal.lastReleaseAt,
    maintainerCount: signal.maintainerCount,
  }));
}

/** Analyzer entrypoint: changed direct deps -> registry metadata -> public-safe maintenance-health findings. */
export async function scanPackageHealth(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<PackageHealthFinding[]> {
  const changes = extractDependencyChanges(req.files ?? [])
    .filter(isQueryable)
    .slice(0, options.limits?.maxQueries ?? MAX_QUERIES);
  const findings: PackageHealthFinding[] = [];
  const maxFindings = options.limits?.maxFindings ?? MAX_FINDINGS;
  for (const change of changes) {
    if (options.signal?.aborted || findings.length >= maxFindings) break;
    for (const finding of await scanChange(change, fetchImpl, options)) {
      findings.push(finding);
      if (findings.length >= maxFindings) break;
    }
  }
  return findings;
}
