// Dependency maintenance-health analyzer (#1511). For each dependency a PR newly adds or upgrades, flags an
// adoption / future-supply-chain risk the no-checkout reviewer cannot see: a version marked DEPRECATED on npm, a
// YANKED PyPI release, or a package that is STALE (no release in over STALE_YEARS). One version-scoped registry
// read per dep; pure classification after that. Additive + fail-safe: a network failure skips that dep, never a
// finding. Public-safe output: package@version + the factual maintenance property (never registry prose).
import type {
  AnalyzerDiagnostics,
  DepHealthFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { boundedFetchJson } from "../external-fetch.js";

const MAX_QUERIES = 25;
const MAX_NPM_JSON_BYTES = 1024 * 1024;
const MAX_PYPI_JSON_BYTES = 2 * 1024 * 1024;
// Precision-first: a mature library can go a while between releases, so require a long gap before calling a
// package stale — the finding is advisory ("verify still maintained"), not a hard block.
const STALE_YEARS = 3;
const STALE_MS = STALE_YEARS * 365 * 24 * 60 * 60 * 1000;

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// npm resolutions must be exact semver (X.Y.Z). A looser class would admit a dist-tag (`latest`, `next`) or a
// partial version (`1`, `1.2`) — e.g. from an `npm:pkg@latest` alias — which is NOT a real key in the packument's
// `versions` map, so deprecation lookup would silently miss and a package-wide stale finding would render as
// `pkg@latest`. Rejecting non-semver skips those (fail-safe), mirroring install-scripts.ts / native-build.ts.
const NPM_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// PyPI is PEP 440, not semver; the manifest parser already guarantees a digit-led version, so validate only that
// the string is non-empty and registry-URL-safe (matches native-build.ts's PYPI_VERSION_RE).
const PYPI_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,63}$/;

interface ScanLimits {
  maxQueries?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** Is this dependency change one we can query a registry for (supported ecosystem + safe name/version)? */
function isQueryable(change: { ecosystem: string; package: string; to: string }): boolean {
  if (change.ecosystem === "npm") return NPM_PACKAGE_RE.test(change.package) && NPM_SEMVER_RE.test(change.to);
  if (change.ecosystem === "PyPI") return PYPI_PACKAGE_RE.test(change.package) && PYPI_VERSION_RE.test(change.to);
  return false;
}

type HealthClass = Pick<DepHealthFinding, "kind" | "reason" | "lastRelease">;

function staleReason(ecosystem: string): string {
  return `no ${ecosystem} release in over ${STALE_YEARS} years — verify the package is still maintained`;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── npm ─────────────────────────────────────────────────────────────────────

/** The subset of an npm packument this analyzer reads. */
export interface NpmPackument {
  "dist-tags"?: { latest?: string };
  versions?: Record<string, { deprecated?: unknown }>;
  time?: Record<string, string>;
}

/** Pure: the timestamp (ms) of the package's most RECENT version publish, or null. Reads ONLY the per-version
 *  entries in the `time` map — deliberately NOT `time.modified`, which npm bumps on any metadata change (a
 *  deprecation, dist-tag move, owner change), so a package with no new release in years but a recent metadata
 *  touch still reads as stale. `time.created`/`time.modified` are skipped; every other key is a published version. */
export function npmLastPublishMs(pkg: NpmPackument): number | null {
  let max = NaN;
  for (const [key, value] of Object.entries(pkg.time ?? {})) {
    if (key === "created" || key === "modified") continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && (!Number.isFinite(max) || ms > max)) max = ms;
  }
  return Number.isFinite(max) ? max : null;
}

/** Pure: classify an npm version's maintenance health (deprecated wins over stale), or null. */
export function classifyNpm(pkg: NpmPackument, version: string, now: number): HealthClass | null {
  const deprecated = pkg.versions?.[version]?.deprecated;
  if (typeof deprecated === "string" && deprecated.trim().length > 0) {
    return { kind: "deprecated", reason: "marked deprecated on the npm registry" };
  }
  const last = npmLastPublishMs(pkg);
  if (last !== null && now - last > STALE_MS) {
    return { kind: "stale", reason: staleReason("npm"), lastRelease: isoDay(last) };
  }
  return null;
}

// ── PyPI ────────────────────────────────────────────────────────────────────

/** The subset of a PyPI package JSON this analyzer reads. */
export interface PypiPackage {
  releases?: Record<string, Array<{ yanked?: boolean; upload_time_iso_8601?: string }>>;
}

/** Pure: is this exact PyPI version yanked? True only when the version has files and every file is yanked. */
export function pypiVersionYanked(pkg: PypiPackage, version: string): boolean {
  const files = pkg.releases?.[version];
  return Array.isArray(files) && files.length > 0 && files.every((file) => file.yanked === true);
}

/** Pure: the newest upload time in ms across every release file, or null. */
export function pypiLastUploadMs(pkg: PypiPackage): number | null {
  let max = NaN;
  for (const files of Object.values(pkg.releases ?? {})) {
    for (const file of files ?? []) {
      const ms = file.upload_time_iso_8601 ? Date.parse(file.upload_time_iso_8601) : NaN;
      if (Number.isFinite(ms) && (!Number.isFinite(max) || ms > max)) max = ms;
    }
  }
  return Number.isFinite(max) ? max : null;
}

/** Pure: classify a PyPI version's maintenance health (yanked wins over stale), or null. */
export function classifyPypi(pkg: PypiPackage, version: string, now: number): HealthClass | null {
  if (pypiVersionYanked(pkg, version)) {
    return { kind: "yanked", reason: "this release is yanked on PyPI and should not be installed" };
  }
  const last = pypiLastUploadMs(pkg);
  if (last !== null && now - last > STALE_MS) {
    return { kind: "stale", reason: staleReason("PyPI"), lastRelease: isoDay(last) };
  }
  return null;
}

// ── Fetch + entrypoint ────────────────────────────────────────────────────────

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: ScanOptions,
  endpointCategory: "npm-packument" | "pypi-json",
  maxBytes: number,
): Promise<T | null> {
  if (options.signal?.aborted) return null;
  const fetchOptions = {
    endpointCategory,
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "dep-health",
    subcall: endpointCategory,
    maxBytes,
    maxCallsPerCategory: options.limits?.maxQueries ?? MAX_QUERIES,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<T>(url, fetchOptions)
    : await boundedFetchJson<T>(url, fetchOptions);
  return response.ok ? response.data : null;
}

/** Analyzer entrypoint: added/changed deps → version-scoped registry metadata → only the deps with a maintenance
 *  risk (deprecated / yanked / stale). `now` is injectable for deterministic staleness tests. */
export async function scanDepHealth(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
  options: ScanOptions = {},
): Promise<DepHealthFinding[]> {
  // Filter to queryable changes BEFORE the cap so unsupported/invalid entries can't starve a later real dep.
  const changes = extractDependencyChanges(req.files ?? [])
    .filter(isQueryable)
    .slice(0, options.limits?.maxQueries ?? MAX_QUERIES);
  const findings: DepHealthFinding[] = [];
  for (const change of changes) {
    if (options.signal?.aborted) break;
    let health: HealthClass | null = null;
    if (change.ecosystem === "npm") {
      const data = await fetchJson<NpmPackument>(
        fetchImpl,
        `https://registry.npmjs.org/${encodeURIComponent(change.package)}`,
        options,
        "npm-packument",
        MAX_NPM_JSON_BYTES,
      );
      health = data && classifyNpm(data, change.to, now);
    } else {
      // PyPI — the only other ecosystem isQueryable admits.
      const data = await fetchJson<PypiPackage>(
        fetchImpl,
        `https://pypi.org/pypi/${encodeURIComponent(change.package)}/json`,
        options,
        "pypi-json",
        MAX_PYPI_JSON_BYTES,
      );
      health = data && classifyPypi(data, change.to, now);
    }
    if (health) {
      findings.push({
        ecosystem: change.ecosystem,
        package: change.package,
        version: change.to,
        ...health,
      });
    }
  }
  return findings;
}
