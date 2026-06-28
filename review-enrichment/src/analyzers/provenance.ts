// Provenance & integrity-attestation analyzer (#1518). Two categories of finding:
// 1. Newly-added npm / PyPI packages that lack published provenance attestations — checked via the npm
//    registry attestations API and the PyPI simple repository JSON API (PEP 740). Missing attestations mean
//    the package was not built through a verifiable CI pipeline, a supply-chain risk the no-checkout
//    reviewer cannot detect.
// 2. Binary files and vendored/minified code committed by the PR — artifacts without an auditable source
//    the reviewer can inspect. Detected purely by path pattern + extension (no network).
import type { EnrichRequest, ProvenanceFinding } from "../types.js";
import { extractDependencyChanges } from "./dependency-scan.js";

const MAX_ATTESTATION_CHECKS = 20; // bound network round-trips
const MAX_FINDINGS = 30; // keep the brief bounded

// Compiled/non-source binary artifact extensions.
const BINARY_EXT_RE =
  /\.(exe|dll|so|dylib|bin|pyc|pyo|class|jar|war|ear|wasm|o|a)$/i;
// Vendored / embedded third-party source trees.
const VENDORED_PATH_RE =
  /(?:^|\/)(?:vendor|node_modules|third[_-]party|vendors)\//;
// Minified files carry no reviewable source in the diff (effectively vendored).
const MINIFIED_RE = /\.min\.[cm]?[jt]s$|\.min\.css$/i;

// Loose safety guards: packages come from parsed manifests, but cap lengths before hitting APIs.
const MAX_PKG_LEN = 200;
const MAX_VER_LEN = 100;
// Version strings must start with a digit and contain only sane chars (end-anchored to reject spaces/pipes).
const VERSION_SAFE_RE = /^[0-9][0-9A-Za-z._+-]*$/;

export function isSafeToCheck(pkg: string, version: string): boolean {
  return (
    pkg.length <= MAX_PKG_LEN &&
    version.length <= MAX_VER_LEN &&
    VERSION_SAFE_RE.test(version)
  );
}

/** Classify a newly-added file by path as binary or vendored. Returns null for ordinary source files. */
export function classifyAddedFile(
  path: string,
): "binary" | "vendored" | null {
  if (VENDORED_PATH_RE.test(path)) return "vendored";
  if (MINIFIED_RE.test(path)) return "vendored";
  if (BINARY_EXT_RE.test(path)) return "binary";
  return null;
}

/** Check whether an npm package version has published provenance attestations (SLSA/sigstore). Returns true
 *  when attested OR when the check cannot be completed (fail-safe: only flag on a confident negative). */
export async function hasNpmAttestation(
  pkg: string,
  version: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  try {
    const res = await fetchImpl(
      `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(`${pkg}@${version}`)}`,
      { signal },
    );
    if (res.status === 404) return false; // unambiguously absent
    if (!res.ok) return true; // other registry error → fail-safe
    const data = (await res.json()) as { attestations?: unknown[] };
    return (data.attestations?.length ?? 0) > 0;
  } catch {
    return true; // network / parse error → fail-safe
  }
}

/** Match a PyPI distribution filename to an exact package version.
 *  PEP 503: -, _, . are equivalent in distribution names. The version must be followed by a wheel
 *  component separator (-) or an sdist archive extension (.tar / .zip) to reject substrings like
 *  `2.31.0` inside `2.31.0.post1` or `12.31.0`. */
export function matchesPypiVersion(
  filename: string,
  pkg: string,
  version: string,
): boolean {
  const normalizedPkg = pkg.toLowerCase().replace(/[-_.]/g, "[-_.]");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${normalizedPkg}-${escapedVersion}(?:-|\\.(?:tar|zip))`,
    "i",
  ).test(filename);
}

/** Check whether a PyPI package version has published provenance (PEP 740 via the simple repository JSON
 *  API). Returns true when provenance is found OR when the check cannot be completed (fail-safe). */
export async function hasPypiProvenance(
  pkg: string,
  version: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  try {
    const res = await fetchImpl(
      `https://pypi.org/simple/${encodeURIComponent(pkg.toLowerCase())}/`,
      {
        signal,
        headers: { Accept: "application/vnd.pypi.simple.v1+json" },
      },
    );
    if (!res.ok) return true; // fail-safe
    const data = (await res.json()) as {
      files?: Array<{ filename: string; provenance?: string }>;
    };
    const versionFiles = (data.files ?? []).filter((f) =>
      matchesPypiVersion(f.filename, pkg, version),
    );
    if (!versionFiles.length) return true; // can't determine → don't flag
    return versionFiles.some((f) => Boolean(f.provenance));
  } catch {
    return true; // fail-safe
  }
}

interface ScanOptions {
  signal?: AbortSignal;
}

/** Analyzer entrypoint: scan for newly-added deps lacking provenance attestations + binary/vendored files. */
export async function scanProvenance(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<ProvenanceFinding[]> {
  const findings: ProvenanceFinding[] = [];

  // 1. Binary / vendored file detection — pure, no network.
  for (const file of req.files ?? []) {
    if (file.status !== "added") continue;
    const kind = classifyAddedFile(file.path);
    if (kind) {
      findings.push({ kind, file: file.path });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }

  // 2. Attestation checks — network, bounded by MAX_ATTESTATION_CHECKS.
  const changes = extractDependencyChanges(req.files ?? []).slice(
    0,
    MAX_ATTESTATION_CHECKS,
  );
  for (const change of changes) {
    if (options.signal?.aborted) break;
    if (findings.length >= MAX_FINDINGS) break;
    if (!isSafeToCheck(change.package, change.to)) continue;

    let attested: boolean;
    if (change.ecosystem === "npm") {
      attested = await hasNpmAttestation(
        change.package,
        change.to,
        fetchImpl,
        options.signal,
      );
    } else if (change.ecosystem === "PyPI") {
      attested = await hasPypiProvenance(
        change.package,
        change.to,
        fetchImpl,
        options.signal,
      );
    } else {
      continue; // Go and other ecosystems — no provenance API to check yet
    }

    if (!attested) {
      findings.push({
        kind: "no-attestation",
        ecosystem: change.ecosystem,
        package: change.package,
        version: change.to,
      });
    }
  }

  return findings;
}
