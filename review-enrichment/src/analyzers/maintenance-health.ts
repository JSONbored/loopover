// Package maintenance-health analyzer (#1511). For each direct dependency a PR adds/upgrades, resolve public
// registry metadata and flag low-noise adoption risks: deprecated releases, yanked PyPI releases, stale/no recent
// releases, and sole-maintainer packages. The no-checkout reviewer cannot fetch this historical metadata; REES can.
import type { EnrichRequest, MaintenanceHealthFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_LOOKUPS = 25;
const LOOKUP_TIMEOUT_MS = 1_500;
const STALE_RELEASE_YEARS = 3;
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

interface RegistrySignal {
  deprecatedMessage?: string | null;
  yanked?: boolean;
  lastReleaseDate?: string | null;
  maintainers?: number | null;
}

function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isStaleRelease(date: string | null, now: number): boolean {
  if (!date) return false;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return false;
  return now - ms >= STALE_RELEASE_YEARS * MS_PER_YEAR;
}

function classifySignals(
  signal: RegistrySignal,
  now: number,
): MaintenanceHealthFinding["reasons"] {
  const reasons: MaintenanceHealthFinding["reasons"] = [];
  if (signal.deprecatedMessage) reasons.push("deprecated");
  if (signal.yanked) reasons.push("yanked");
  if (isStaleRelease(signal.lastReleaseDate ?? null, now))
    reasons.push("stale-release");
  if (signal.maintainers === 1) reasons.push("sole-maintainer");
  return reasons;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

interface NpmRegistryVersion {
  deprecated?: string;
}

interface NpmRegistryDoc {
  versions?: Record<string, NpmRegistryVersion | undefined>;
  time?: Record<string, string | undefined>;
  maintainers?: unknown[];
}

export async function fetchNpmSignals(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RegistrySignal | null> {
  const data = (await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    fetchImpl,
    signal,
  )) as NpmRegistryDoc | null;
  if (!data) return null;
  const versionDoc = data.versions?.[version];
  return {
    deprecatedMessage:
      typeof versionDoc?.deprecated === "string"
        ? versionDoc.deprecated.replace(/\s+/g, " ").slice(0, 180)
        : null,
    lastReleaseDate:
      toIsoDate(data.time?.[version]) ??
      toIsoDate(data.time?.modified) ??
      null,
    maintainers: Array.isArray(data.maintainers) ? data.maintainers.length : null,
  };
}

interface PypiReleaseFile {
  upload_time_iso_8601?: string;
  yanked?: boolean;
}

interface PypiProjectInfo {
  deprecated?: boolean | string;
  maintainer?: string | null;
  maintainer_email?: string | null;
}

interface PypiDoc {
  info?: PypiProjectInfo;
  releases?: Record<string, PypiReleaseFile[] | undefined>;
}

export async function fetchPypiSignals(
  name: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RegistrySignal | null> {
  const data = (await fetchJson(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    fetchImpl,
    signal,
  )) as PypiDoc | null;
  if (!data) return null;
  const files = data.releases?.[version] ?? [];
  const uploadTimes = files
    .map((item) => toIsoDate(item.upload_time_iso_8601))
    .filter((value): value is string => Boolean(value))
    .sort();
  const maintainerHints = new Set(
    [data.info?.maintainer, data.info?.maintainer_email]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const deprecated =
    typeof data.info?.deprecated === "string"
      ? data.info.deprecated
      : data.info?.deprecated
        ? "PyPI metadata marks this project deprecated"
        : null;
  return {
    deprecatedMessage: deprecated,
    yanked: files.some((item) => item.yanked === true),
    lastReleaseDate: uploadTimes.at(-1) ?? null,
    maintainers: maintainerHints.size ? maintainerHints.size : null,
  };
}

/** Analyzer entrypoint: direct dependency adds/bumps → public registry maintenance metadata → only risky ones. */
export async function scanMaintenanceHealth(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<MaintenanceHealthFinding[]> {
  const findings: MaintenanceHealthFinding[] = [];
  const now = options.now ?? Date.now();
  const changes = extractDependencyChanges(req.files ?? []).slice(0, MAX_LOOKUPS);
  for (const change of changes) {
    if (options.signal?.aborted) break;
    const signal =
      change.ecosystem === "npm"
        ? await fetchNpmSignals(change.package, change.to, fetchImpl, options.signal)
        : change.ecosystem === "PyPI"
          ? await fetchPypiSignals(
              change.package,
              change.to,
              fetchImpl,
              options.signal,
            )
          : null;
    if (!signal) continue;
    const reasons = classifySignals(signal, now);
    if (!reasons.length) continue;
    findings.push({
      ecosystem: change.ecosystem,
      package: change.package,
      version: change.to,
      reasons,
      deprecatedMessage: signal.deprecatedMessage ?? null,
      lastReleaseDate: signal.lastReleaseDate ?? null,
      maintainers: signal.maintainers ?? null,
    });
  }
  return findings;
}
