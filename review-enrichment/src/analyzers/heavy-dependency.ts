// Heavy-dependency-for-trivial-use analyzer (#1505). For each newly-added/upgraded npm dependency, count direct
// import/require usage in the PR's added lines and fetch package weight metadata. Flag only when the package is
// both materially heavy and used trivially, so the review brief can ask whether a local helper/native API would do.
import type { EnrichRequest, HeavyDependencyFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_WEIGHT_LOOKUPS = 20;
const MAX_FINDINGS = 15;
const TRIVIAL_USAGE_MAX = 2;
const MIN_INSTALL_BYTES = 500_000;
const MIN_BUNDLE_BYTES = 80_000;
const MIN_GZIP_BYTES = 25_000;

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
}

function isSafeNpmPackageVersion(name: string, version: string): boolean {
  return NPM_PACKAGE_RE.test(name) && SEMVER_RE.test(version);
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
      if (raw.startsWith("+") && !raw.startsWith("+++")) {
        lines.push({
          file: file.path,
          line: nextLine || 1,
          text: raw.slice(1),
        });
        nextLine += 1;
        continue;
      }
      if (raw.startsWith("-") && !raw.startsWith("---")) continue;
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

function specifierMatchesPackage(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

export function countPackagePatchUsages(
  files: NonNullable<EnrichRequest["files"]>,
  pkg: string,
): Pick<HeavyDependencyFinding, "usageCount" | "usageLocations"> {
  const locations: HeavyDependencyFinding["usageLocations"] = [];
  for (const line of addedPatchLines(files)) {
    const matches = moduleSpecifiers(line.text).filter((specifier) =>
      specifierMatchesPackage(specifier, pkg),
    );
    for (let i = 0; i < matches.length; i += 1) {
      locations.push({ file: line.file, line: line.line });
    }
  }
  return {
    usageCount: locations.length,
    usageLocations: locations.slice(0, TRIVIAL_USAGE_MAX),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function queryPackageWeight(
  pkg: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PackageWeight | null> {
  if (signal?.aborted) return null;
  try {
    const packageSpec = encodeURIComponent(`${pkg}@${version}`);
    const response = await fetchImpl(
      `https://bundlephobia.com/api/size?package=${packageSpec}`,
      { signal },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      installSize?: unknown;
      size?: unknown;
      gzip?: unknown;
      dependencyCount?: unknown;
    };
    return {
      installSizeBytes: numberOrNull(data.installSize),
      bundleSizeBytes: numberOrNull(data.size),
      gzipSizeBytes: numberOrNull(data.gzip),
      dependencyCount: numberOrNull(data.dependencyCount),
    };
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
  let weightLookups = 0;

  for (const change of changes) {
    if (options.signal?.aborted || findings.length >= MAX_FINDINGS) break;
    if (!isSafeNpmPackageVersion(change.package, change.to)) continue;

    const usage = countPackagePatchUsages(req.files ?? [], change.package);
    if (usage.usageCount < 1 || usage.usageCount > TRIVIAL_USAGE_MAX) continue;
    if (weightLookups >= MAX_WEIGHT_LOOKUPS) break;
    weightLookups += 1;

    const weight = await queryPackageWeight(
      change.package,
      change.to,
      fetchImpl,
      options.signal,
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
