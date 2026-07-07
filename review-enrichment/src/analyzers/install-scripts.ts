// Install-script & lifecycle-hook auditor (brainstorm #2). For each npm dependency a PR adds/upgrades, fetches the
// registry metadata for that exact version and flags ones that ship preinstall/install/postinstall scripts — the #1 npm-malware execution
// vector (a script runs on `npm install`, before any code review of the package's source). The shipped CVE scan
// misses this entirely; the no-checkout reviewer can't fetch registry metadata. Public-safe output: package@version + the
// hook names + publish date (NOT the script body, to keep the brief compact and non-executable).
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  InstallScriptFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { extractDependencyChanges } from "./dependency-scan.js";
import { boundedFetchJson } from "../external-fetch.js";

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const NPM_PACKAGE_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_VERSION_LOOKUPS = 25;
const NPM_REGISTRY_TIMEOUT_MS = 5000; // npm registry can be slow; 1200ms default is too aggressive
// npm version-specific endpoint responses are typically small (< 50 KB); 128 KB gives enough headroom
// while rejecting unexpectedly large responses quickly before they consume timeout budget.
const MAX_VERSION_JSON_BYTES = 128 * 1024;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface NpmVersionMetadata {
  version?: string;
  scripts?: Record<string, string>;
  time?: string;
}

interface NpmPackumentMetadata {
  versions?: Record<string, NpmVersionMetadata>;
  time?: Record<string, string>;
  "dist-tags"?: Record<string, string>;
}

function isPackumentMetadata(
  data: NpmVersionMetadata | NpmPackumentMetadata,
): data is NpmPackumentMetadata {
  return Boolean(
    "versions" in data &&
      data.versions &&
      typeof data.versions === "object" &&
      hasPackumentMarker(data) &&
      !hasVersionMetadata(data),
  );
}

function hasPackumentMarker(
  data: NpmVersionMetadata | NpmPackumentMetadata,
): boolean {
  // Exact version metadata can contain a package-owned `versions` field; packuments also carry package-level markers.
  const time = (data as NpmPackumentMetadata).time;
  const distTags = (data as NpmPackumentMetadata)["dist-tags"];
  return Boolean(
    (time && typeof time === "object") ||
      (distTags && typeof distTags === "object"),
  );
}

function hasVersionMetadata(
  data: NpmVersionMetadata | NpmPackumentMetadata,
): data is NpmVersionMetadata {
  return Boolean(
    "scripts" in data ||
      ("time" in data && (typeof data.time === "string" || data.time === undefined)),
  );
}

function hasExactVersionIdentity(
  data: NpmVersionMetadata | NpmPackumentMetadata,
  version: string,
): data is NpmVersionMetadata {
  return (data as { version?: unknown }).version === version;
}

function exactPublishedAt(data: NpmVersionMetadata | NpmPackumentMetadata): string | null {
  const time = (data as { time?: unknown }).time;
  return typeof time === "string" ? time : null;
}

function versionMetadata(
  data: NpmVersionMetadata | NpmPackumentMetadata,
  version: string,
): NpmVersionMetadata | undefined {
  if (hasExactVersionIdentity(data, version)) return data;
  if (hasVersionMetadata(data)) return data;
  return isPackumentMetadata(data) ? data.versions?.[version] : data;
}

function publishedAt(
  data: NpmVersionMetadata | NpmPackumentMetadata,
  version: string,
): string | null {
  if (hasExactVersionIdentity(data, version)) return exactPublishedAt(data);
  if (hasVersionMetadata(data)) return data.time ?? null;
  return isPackumentMetadata(data) ? data.time?.[version] ?? null : null;
}

function isSafeNpmChange(name: string, version: string): boolean {
  return NPM_PACKAGE_RE.test(name) && SEMVER_RE.test(version);
}

/** Analyzer entrypoint: changed npm deps → registry version metadata → only the versions that run install scripts. */
export async function scanInstallScripts(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<InstallScriptFinding[]> {
  const findings: InstallScriptFinding[] = [];
  let lookups = 0;
  for (const change of extractDependencyChanges(req.files ?? [])) {
    if (options.signal?.aborted || lookups >= MAX_VERSION_LOOKUPS) break;
    if (
      change.ecosystem !== "npm" ||
      !isSafeNpmChange(change.package, change.to)
    )
      continue;
    lookups += 1;
    const url = `https://registry.npmjs.org/${encodeURIComponent(change.package)}/${encodeURIComponent(change.to)}`;
    const fetchOptions = {
      endpointCategory: "npm-version",
      signal: options.signal,
      fetchImpl,
      diagnostics: options.diagnostics,
      phase: "install-script",
      subcall: "npm-version",
      maxBytes: MAX_VERSION_JSON_BYTES,
      maxCallsPerCategory: MAX_VERSION_LOOKUPS,
      timeoutMs: NPM_REGISTRY_TIMEOUT_MS,
    };
    const response = options.analysis
      ? await options.analysis.fetchJson<NpmVersionMetadata | NpmPackumentMetadata>(url, fetchOptions)
      : await boundedFetchJson<NpmVersionMetadata | NpmPackumentMetadata>(url, fetchOptions);
    if (!response.ok) {
      if (response.reason === "response_too_large") {
        findings.push({
          package: change.package,
          version: change.to,
          hooks: [],
          publishedAt: null,
          metadataCapped: true,
        });
      }
      continue;
    }
    const data = response.data;
    const version = versionMetadata(data, change.to);
    const scripts = version?.scripts ?? {};
    const hooks = INSTALL_HOOKS.filter(
      (hook) => typeof scripts[hook] === "string",
    );
    if (hooks.length) {
      findings.push({
        package: change.package,
        version: change.to,
        hooks,
        publishedAt: publishedAt(data, change.to),
      });
    }
  }
  return findings;
}
