// Lockfile-tamper-risk gate check (#2563). Deterministic scan of a changed `package-lock.json` (or another
// `*.lock` file) diff for the classic supply-chain tell: a `resolved`/`integrity` value changed WITHOUT the
// corresponding `package.json` dependency version changing, or a `resolved` URL that points outside the public
// npm registry. Distinct from the OSV.dev CVE analyzer (review-enrichment/src/analyzers/lockfile-drift.ts) —
// that flags KNOWN-CVE versions; this flags tamper/integrity-substitution regardless of whether the substituted
// version has a published CVE. Config-driven, off by default (see rules/advisory.ts isConfiguredGateBlocker +
// signals/focus-manifest.ts gate.lockfileIntegrity) — this module only PRODUCES the finding; it never decides
// whether the finding blocks.

import type { AdvisoryFinding, PullRequestFileRecord } from "../types";

const NPM_REGISTRY_HOST_RE = /^https:\/\/registry\.npmjs\.org\//i;

// Package-lock "packages" entries are keyed either `"node_modules/<pkg>"` (lockfileVersion 2/3) or a bare
// `"<pkg>"` (lockfileVersion 1 "dependencies" tree, and yarn/pnpm equivalents keep a similar bare-name header).
// Root ("": {...}) and pure container headers ("packages": {...}, "dependencies": {...}) are never package
// entries themselves.
const CONTAINER_KEYS = new Set(["", "packages", "dependencies", "devDependencies", "optionalDependencies"]);

function npmPackageFromNodeModulesPath(path: string): string | null {
  const marker = "node_modules/";
  const i = path.lastIndexOf(marker);
  if (i < 0) return null;
  const rest = path.slice(i + marker.length);
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return rest.split("/")[0] || null;
}

/** True when `path`'s basename is `package-lock.json` — the only lockfile format this check parses today
 *  (npm/lockfileVersion 2-3 JSON shape). Matches ANY directory depth (root, `review-enrichment/`,
 *  `apps/gittensory-ui/`, or a future workspace) rather than a hardcoded path list, so a new workspace package
 *  is covered without a code change. */
export function isNpmLockfilePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  return basename === "package-lock.json";
}

type PatchLine = { sign: "+" | "-" | " "; content: string };

function* patchLines(patch: string): Generator<PatchLine> {
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ") || raw.startsWith("--- ") || raw.startsWith("@@")) continue;
    const first = raw[0];
    if (first === "+") yield { sign: "+", content: raw.slice(1) };
    else if (first === "-") yield { sign: "-", content: raw.slice(1) };
    else yield { sign: " ", content: raw.slice(1) };
  }
}

type LockfileTamperCandidate = {
  file: string;
  package: string;
  /** True when a `resolved`/`integrity` value changed for this package block in the diff. */
  resolvedOrIntegrityChanged: boolean;
  /** A `+resolved` URL seen for this package block that does not point at registry.npmjs.org, or null. */
  offRegistryResolvedUrl: string | null;
};

/** Parse one `package-lock.json` unified-diff patch for per-package resolved/integrity changes. Heuristic
 *  line-based scan (mirrors review-enrichment's lockfile-drift parser), not a full JSON parse — good enough to
 *  flag suspicious hunks without needing the complete (potentially huge) lockfile tree in memory. */
function scanPackageLockPatch(path: string, patch: string): LockfileTamperCandidate[] {
  const byPackage = new Map<string, LockfileTamperCandidate>();
  let currentPackage: string | null = null;
  let sawPackagesEntry = false;
  for (const line of patchLines(patch)) {
    const body = line.content.trim();
    const objectHeader = /^"([^"]+)"\s*:\s*\{/.exec(body);
    if (objectHeader) {
      const key = objectHeader[1]!;
      const nodeModulesPackage = npmPackageFromNodeModulesPath(key);
      if (nodeModulesPackage) {
        currentPackage = nodeModulesPackage;
        sawPackagesEntry = true;
      } else if (!sawPackagesEntry && !CONTAINER_KEYS.has(key)) {
        currentPackage = key;
      } else {
        currentPackage = null;
      }
      continue;
    }
    if (body === "}" || body.startsWith("},")) currentPackage = null;
    if (!currentPackage || line.sign === " ") continue;

    const resolvedMatch = /^"resolved"\s*:\s*"([^"]*)"/.exec(body);
    const integrityMatch = /^"integrity"\s*:\s*"([^"]*)"/.exec(body);
    if (!resolvedMatch && !integrityMatch) continue;

    const entry =
      byPackage.get(currentPackage) ??
      ({ file: path, package: currentPackage, resolvedOrIntegrityChanged: false, offRegistryResolvedUrl: null } satisfies LockfileTamperCandidate);
    entry.resolvedOrIntegrityChanged = true;
    if (resolvedMatch && line.sign === "+" && resolvedMatch[1] && !NPM_REGISTRY_HOST_RE.test(resolvedMatch[1])) {
      entry.offRegistryResolvedUrl = resolvedMatch[1];
    }
    byPackage.set(currentPackage, entry);
  }
  return [...byPackage.values()];
}

// `"<name>": "<range>"` inside a package.json dependency block, e.g. `"lodash": "^4.17.21",`. Line-based, not a
// full JSON parse — the same heuristic review-enrichment's dependency-scan.ts uses for the same shape.
const PACKAGE_JSON_DEP_RE = /^"([^"]+)"\s*:\s*"([^"]+)"/;

/** Package names whose declared `package.json` version range CHANGED somewhere in this PR's diff (across every
 *  changed `package.json`, any dependency block) — a `+`/`-` pair with different range strings for the same key
 *  counts as changed; a line present on only one side (add/remove of the dependency entirely) also counts. */
function packagesWithManifestVersionChange(files: PullRequestFileRecord[]): Set<string> {
  const changed = new Set<string>();
  for (const file of files) {
    if (file.path.replace(/\\/g, "/").toLowerCase().split("/").pop() !== "package.json") continue;
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (!patch) continue;
    const removedVersions = new Map<string, string>();
    const addedVersions = new Map<string, string>();
    for (const line of patchLines(patch)) {
      if (line.sign === " ") continue;
      const match = PACKAGE_JSON_DEP_RE.exec(line.content.trim());
      if (!match) continue;
      const [, name, range] = match as unknown as [string, string, string];
      (line.sign === "+" ? addedVersions : removedVersions).set(name, range);
    }
    for (const [name, addedRange] of addedVersions) {
      const removedRange = removedVersions.get(name);
      if (removedRange === undefined || removedRange !== addedRange) changed.add(name);
    }
    for (const name of removedVersions.keys()) {
      if (!addedVersions.has(name)) changed.add(name);
    }
  }
  return changed;
}

const MAX_FLAGGED_PACKAGES_IN_TITLE = 3;

/**
 * Scan every changed `package-lock.json` in the PR for a tamper-risk hunk: a `resolved`/`integrity` value
 * changed WITHOUT the same package's version changing in a changed `package.json`, or a `resolved` URL outside
 * `registry.npmjs.org`. Returns ONE `lockfile_tamper_risk` advisory finding on any hit, else null. Callers gate
 * this on the repo's `lockfileIntegrityGateMode` (default `off` — see rules/advisory.ts) before invoking it.
 */
export function lockfileTamperRiskFinding(files: PullRequestFileRecord[]): AdvisoryFinding | null {
  const lockfiles = files.filter((file) => isNpmLockfilePath(file.path));
  if (lockfiles.length === 0) return null;
  const bumpedPackages = packagesWithManifestVersionChange(files);

  const flagged: { file: string; package: string; reason: "off_registry" | "unbumped_resolved" }[] = [];
  for (const file of lockfiles) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (!patch) continue;
    for (const candidate of scanPackageLockPatch(file.path, patch)) {
      if (candidate.offRegistryResolvedUrl) {
        flagged.push({ file: candidate.file, package: candidate.package, reason: "off_registry" });
      } else if (candidate.resolvedOrIntegrityChanged && !bumpedPackages.has(candidate.package)) {
        flagged.push({ file: candidate.file, package: candidate.package, reason: "unbumped_resolved" });
      }
    }
  }
  if (flagged.length === 0) return null;

  const names = [...new Set(flagged.map((f) => f.package))];
  const shownNames = names.slice(0, MAX_FLAGGED_PACKAGES_IN_TITLE).join(", ");
  const moreSuffix = names.length > MAX_FLAGGED_PACKAGES_IN_TITLE ? ` +${names.length - MAX_FLAGGED_PACKAGES_IN_TITLE} more` : "";
  const hasOffRegistry = flagged.some((f) => f.reason === "off_registry");
  const hasUnbumped = flagged.some((f) => f.reason === "unbumped_resolved");
  const detailParts: string[] = [];
  if (hasOffRegistry) detailParts.push("a resolved URL points outside registry.npmjs.org");
  if (hasUnbumped) detailParts.push("a resolved/integrity value changed without a matching package.json version bump");

  return {
    code: "lockfile_tamper_risk",
    severity: "warning",
    title: `Possible lockfile tamper risk (${shownNames}${moreSuffix})`,
    detail: `The lockfile diff for ${[...new Set(flagged.map((f) => f.file))].join(", ")} is suspicious: ${detailParts.join("; ")}. Affected package(s): ${names.join(", ")}.`,
    action: "Re-run the package manager's install/lock command to regenerate the lockfile from package.json rather than hand-editing resolved/integrity entries, and confirm every resolved URL is on the public npm registry.",
  };
}
