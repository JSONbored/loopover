// Native-build / install-cost analyzer (#1512). For each dependency a PR newly adds or upgrades, flags the ones
// whose install does real work the manifest diff never shows: an npm package that compiles a native addon
// (node-gyp / gypfile) on install, or a PyPI release that ships no prebuilt wheel (sdist-only) so pip compiles from
// source. Both are a hidden CI cold-start cost and a frequent cross-platform breakage source. Factual signals from
// the registry metadata only — the no-checkout reviewer can fetch neither. Reports package@version + the property.
import type { EnrichRequest, NativeBuildFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_QUERIES = 25;
const MAX_REGISTRY_JSON_BYTES = 2 * 1024 * 1024;
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
// Tokens in an install-lifecycle script that indicate a native toolchain runs on install.
const NATIVE_TOOL_RE = /\b(node-gyp|node-pre-gyp|prebuild|prebuild-install|cmake-js|node-addon-api|nan)\b/;
// Tokens that mean prebuilt binaries are DOWNLOADED (compile only as a fallback for an unmatched platform/ABI).
const PREBUILT_TOOL_RE = /\b(node-pre-gyp|prebuild-install)\b/;

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
}

interface ScanOptions {
  signal?: AbortSignal;
  limits?: ScanLimits;
}

/** npm packument version metadata, the subset that signals a native build. */
export interface NpmVersionMeta {
  gypfile?: boolean;
  binary?: unknown;
  scripts?: Record<string, string>;
}

/** Pure: does this npm version compile a native addon on install? Returns a reason (+ whether a prebuilt fallback
 *  exists), or null. Signals: `gypfile: true`, or an install/preinstall/postinstall script that runs a native tool. */
export function npmNativeBuild(meta: NpmVersionMeta): { reason: string; prebuiltFallback: boolean } | null {
  const installScript = INSTALL_HOOKS.map((hook) => meta.scripts?.[hook] ?? "").join(" ");
  const isNative = meta.gypfile === true || NATIVE_TOOL_RE.test(installScript);
  if (!isNative) return null;
  const prebuiltFallback = Boolean(meta.binary) || PREBUILT_TOOL_RE.test(installScript);
  const reason = prebuiltFallback
    ? "ships a native addon with prebuilt binaries — compiles from source only when no prebuilt matches the platform/Node ABI"
    : "compiles a native addon (node-gyp) on install — cold-CI build cost and a cross-platform breakage source";
  return { reason, prebuiltFallback };
}

/** A PyPI release file entry (from the `urls` array of the version JSON). */
export interface PypiUrl {
  packagetype?: string;
}

/** Pure: is this PyPI version sdist-only (a source dist is published but no prebuilt wheel)? Requires an actual
 *  `sdist` so an empty or wheel-less-but-also-sdist-less file set is not mistaken for "compiles from source". */
export function pypiSdistOnly(urls: PypiUrl[]): boolean {
  const hasSdist = urls.some((url) => url.packagetype === "sdist");
  const hasWheel = urls.some((url) => url.packagetype === "bdist_wheel");
  return hasSdist && !hasWheel;
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
    const text = await readJsonText(response);
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJsonText(response: Response): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_REGISTRY_JSON_BYTES) return null;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_REGISTRY_JSON_BYTES) return null;
    return new TextDecoder().decode(buffer);
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REGISTRY_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Analyzer entrypoint: added/changed deps → registry metadata → only the versions with a native-build install cost. */
export async function scanNativeBuild(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<NativeBuildFinding[]> {
  // Filter to queryable (supported, URL-safe) changes BEFORE applying the cap, so unsupported/invalid entries can't
  // consume the budget and starve a later native dependency.
  const changes = extractDependencyChanges(req.files ?? [])
    .filter(isQueryable)
    .slice(0, options.limits?.maxQueries ?? MAX_QUERIES);
  const findings: NativeBuildFinding[] = [];
  for (const change of changes) {
    if (options.signal?.aborted) break;

    if (change.ecosystem === "npm") {
      const data = (await fetchJson(
        fetchImpl,
        `https://registry.npmjs.org/${encodeURIComponent(change.package)}`,
        options.signal,
      )) as { versions?: Record<string, NpmVersionMeta> } | null;
      const meta = data?.versions?.[change.to];
      const native = meta && npmNativeBuild(meta);
      if (native) {
        findings.push({
          ecosystem: change.ecosystem,
          package: change.package,
          version: change.to,
          kind: "native-addon",
          prebuiltFallback: native.prebuiltFallback,
          reason: native.reason,
        });
      }
    } else {
      // PyPI — the only other ecosystem isQueryable admits.
      const data = (await fetchJson(
        fetchImpl,
        `https://pypi.org/pypi/${encodeURIComponent(change.package)}/${encodeURIComponent(change.to)}/json`,
        options.signal,
      )) as { urls?: PypiUrl[] } | null;
      if (data && pypiSdistOnly(data.urls ?? [])) {
        findings.push({
          ecosystem: change.ecosystem,
          package: change.package,
          version: change.to,
          kind: "sdist-only",
          reason: "no prebuilt wheel for this version — pip compiles from source (sdist) on install",
        });
      }
    }
  }
  return findings;
}
