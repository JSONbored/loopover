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
const MAX_VERSION_JSON_BYTES = 256 * 1024;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

interface NpmVersionMetadata {
  scripts?: Record<string, string>;
  time?: string;
}

interface NpmPackumentMetadata {
  versions?: Record<string, NpmVersionMetadata>;
  time?: Record<string, string>;
}

function isPackumentMetadata(
  data: NpmVersionMetadata | NpmPackumentMetadata,
): data is NpmPackumentMetadata {
  return "versions" in data;
}

function versionMetadata(
  data: NpmVersionMetadata | NpmPackumentMetadata,
  version: string,
): NpmVersionMetadata | undefined {
  return isPackumentMetadata(data) ? data.versions?.[version] : data;
}

function publishedAt(
  data: NpmVersionMetadata | NpmPackumentMetadata,
  version: string,
): string | null {
  if (isPackumentMetadata(data)) return data.time?.[version] ?? null;
  return data.time ?? null;
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
    };
    const response = options.analysis
      ? await options.analysis.fetchJson<NpmVersionMetadata | NpmPackumentMetadata>(url, fetchOptions)
      : await boundedFetchJson<NpmVersionMetadata | NpmPackumentMetadata>(url, fetchOptions);
    if (!response.ok) continue;
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
