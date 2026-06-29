// Package maintenance-health / deprecated-dep analyzer (#1511). For each dependency a PR newly ADDS or UPGRADES,
// flags the ones a maintainer would want to know about but the no-checkout reviewer cannot derive: a package that
// is DEPRECATED, or STALE (no release in roughly N years). Two deterministic registry signals only — no flaky
// "archived"/sole-maintainer/Scorecard probes. Reports package@version + a short factual reason from the metadata.
//   - npm: the packument `deprecated` field (non-empty string ⇒ deprecated, surface a short reason) and the `time`
//     map (the newest version's publish date — stale when the most recent publish is older than the threshold).
//   - PyPI: `info.yanked` (+ `yanked_reason`) for the queried version, and the newest release's upload date for
//     staleness (same threshold).
import type { EnrichRequest, DepMaintenanceHealthFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_QUERIES = 25;
// Staleness threshold: flag a package whose most recent release is older than this. Two years in ms.
const STALE_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const PYPI_PACKAGE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// PyPI versions are PEP 440, not semver: `1.0`, `24.1`, `1.0rc1`, `1.0.post1`, `1!2.0`. Validate only that the
// string is non-empty and URL-path-safe (it goes into the version JSON URL) rather than imposing semver.
const PYPI_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+!-]{0,63}$/;

/** Is this dependency change one we can query a registry for (supported ecosystem + URL-safe name/version)? */
function isQueryable(change: { ecosystem: string; package: string; to: string }): boolean {
  if (change.ecosystem === "npm") return NPM_PACKAGE_RE.test(change.package) && SEMVER_RE.test(change.to);
  if (change.ecosystem === "PyPI") return PYPI_PACKAGE_RE.test(change.package) && PYPI_VERSION_RE.test(change.to);
  return false;
}

interface ScanLimits {
  maxQueries?: number;
  staleAgeMs?: number;
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

/** A maintenance signal derived from registry metadata: `deprecated`/`yanked`, or `stale`. */
type Health = { kind: "deprecated" | "yanked" | "stale"; reason: string };

/** Collapse whitespace and cap the length of a registry-supplied reason so the rendered line stays short + safe. */
function tidyReason(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Pure: the most recent publish date (ms epoch) from an npm `time` map, ignoring the `created`/`modified`
 *  pseudo-entries and any unparseable timestamp. Returns null when no real, parseable publish date exists. */
export function newestNpmPublishMs(time: Record<string, string> | undefined): number | null {
  if (!time) return null;
  let newest: number | null = null;
  for (const [version, iso] of Object.entries(time)) {
    if (version === "created" || version === "modified") continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue; // garbage timestamp → ignore this entry (fail safe, don't flag)
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/** npm packument subset that carries the maintenance signals. `deprecated` is a string (the reason) when set, but
 *  registries have historically also emitted `true`/`false` — both non-string forms are handled defensively. */
export interface NpmPackument {
  deprecated?: unknown;
  time?: Record<string, string>;
}

/** Pure: classify an npm package from its packument. A non-empty `deprecated` STRING ⇒ deprecated (with its
 *  reason); otherwise stale when the newest real publish is older than `staleAgeMs`. `now` injected for tests. */
export function npmHealth(
  meta: NpmPackument,
  staleAgeMs: number,
  now: number,
): Health | null {
  // `deprecated` is the reason string; a boolean/empty/whitespace value is NOT a deprecation (fail safe).
  if (typeof meta.deprecated === "string" && meta.deprecated.trim() !== "") {
    return { kind: "deprecated", reason: `deprecated by maintainer — ${tidyReason(meta.deprecated)}` };
  }
  const newest = newestNpmPublishMs(meta.time);
  if (newest !== null && now - newest > staleAgeMs) {
    const years = Math.floor((now - newest) / (365 * 24 * 60 * 60 * 1000));
    return { kind: "stale", reason: `no release in ~${years}y (last publish ${new Date(newest).toISOString().slice(0, 10)})` };
  }
  return null;
}

/** PyPI version JSON subset: the queried version's `info` (yanked flag/reason) and the `releases` map (upload
 *  dates per version) used for the staleness signal. */
export interface PypiVersionJson {
  info?: { yanked?: boolean; yanked_reason?: string | null };
  releases?: Record<string, Array<{ upload_time_iso_8601?: string; upload_time?: string }>>;
}

/** Pure: the most recent upload date (ms epoch) across all releases, ignoring unparseable timestamps. Null when
 *  no parseable upload date exists. */
export function newestPypiUploadMs(releases: PypiVersionJson["releases"]): number | null {
  if (!releases) return null;
  let newest: number | null = null;
  for (const files of Object.values(releases)) {
    for (const file of files ?? []) {
      const iso = file.upload_time_iso_8601 ?? file.upload_time;
      if (!iso) continue;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) continue; // garbage timestamp → ignore (fail safe)
      if (newest === null || ms > newest) newest = ms;
    }
  }
  return newest;
}

/** Pure: classify a PyPI release from its version JSON. The queried version being `yanked` ⇒ yanked (with its
 *  reason when present); otherwise stale when the newest upload is older than `staleAgeMs`. `now` injected. */
export function pypiHealth(
  data: PypiVersionJson,
  staleAgeMs: number,
  now: number,
): Health | null {
  if (data.info?.yanked === true) {
    const why = typeof data.info.yanked_reason === "string" && data.info.yanked_reason.trim() !== ""
      ? ` — ${tidyReason(data.info.yanked_reason)}`
      : "";
    return { kind: "yanked", reason: `release yanked from PyPI${why}` };
  }
  const newest = newestPypiUploadMs(data.releases);
  if (newest !== null && now - newest > staleAgeMs) {
    const years = Math.floor((now - newest) / (365 * 24 * 60 * 60 * 1000));
    return { kind: "stale", reason: `no release in ~${years}y (last upload ${new Date(newest).toISOString().slice(0, 10)})` };
  }
  return null;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  if (signal?.aborted) return null;
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Analyzer entrypoint: added/upgraded deps → registry metadata → only the deps that are deprecated/yanked or stale. */
export async function scanDepMaintenanceHealth(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<DepMaintenanceHealthFinding[]> {
  const staleAgeMs = options.limits?.staleAgeMs ?? STALE_AGE_MS;
  const now = Date.now();
  // Filter to queryable (supported, URL-safe) changes BEFORE applying the cap, so unsupported/invalid entries
  // can't consume the budget and starve a later real dependency.
  const changes = extractDependencyChanges(req.files ?? [])
    .filter(isQueryable)
    .slice(0, options.limits?.maxQueries ?? MAX_QUERIES);
  const findings: DepMaintenanceHealthFinding[] = [];
  for (const change of changes) {
    if (options.signal?.aborted) break;

    if (change.ecosystem === "npm") {
      const data = (await fetchJson(
        fetchImpl,
        `https://registry.npmjs.org/${encodeURIComponent(change.package)}`,
        options.signal,
      )) as NpmPackument | null;
      const health = data && npmHealth(data, staleAgeMs, now);
      if (health) {
        findings.push({
          ecosystem: change.ecosystem,
          package: change.package,
          version: change.to,
          kind: health.kind,
          reason: health.reason,
        });
      }
    } else {
      // PyPI — the only other ecosystem isQueryable admits.
      const data = (await fetchJson(
        fetchImpl,
        `https://pypi.org/pypi/${encodeURIComponent(change.package)}/${encodeURIComponent(change.to)}/json`,
        options.signal,
      )) as PypiVersionJson | null;
      const health = data && pypiHealth(data, staleAgeMs, now);
      if (health) {
        findings.push({
          ecosystem: change.ecosystem,
          package: change.package,
          version: change.to,
          kind: health.kind,
          reason: health.reason,
        });
      }
    }
  }
  return findings;
}
