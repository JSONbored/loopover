// Lockfile-tamper-risk gate check (#2563). Deterministic scan of a changed `package-lock.json` (or another
// `*.lock` file) diff for the classic supply-chain tell: a `resolved`/`integrity` value changed WITHOUT that
// SAME package-lock entry's own `"version"` field genuinely changing, or a `resolved` URL that points outside
// the public npm registry. Distinct from the OSV.dev CVE analyzer (review-enrichment/src/analyzers/lockfile-drift.ts)
// — that flags KNOWN-CVE versions; this flags tamper/integrity-substitution regardless of whether the substituted
// version has a published CVE. Config-driven, off by default (see rules/advisory.ts isConfiguredGateBlocker +
// signals/focus-manifest.ts gate.lockfileIntegrity) — this module only PRODUCES the finding; it never decides
// whether the finding blocks.
//
// Why compare against the lockfile entry's OWN version rather than package.json (see #2563 gate-review
// follow-up on #2676): every package-lock.json entry — direct AND transitive — carries its own version/
// resolved/integrity trio, and a genuine `npm install`/`npm update` always bumps all three together for any
// entry it touches. package.json, by contrast, only lists DIRECT dependencies, so the vast majority of lockfile
// entries (transitive dependencies) never appear there at all; treating "package.json didn't change" as a
// tamper signal made every ordinary transitive bump misfire. A hand-edited resolved/integrity pointing at
// malicious content while its OWN declared version is left unchanged (to look unremarkable) is a more specific,
// self-contained tell that doesn't require cross-referencing a different file.

import type { AdvisoryFinding, PullRequestFileRecord } from "../types";

const NPM_REGISTRY_HOST_RE = /^https:\/\/registry\.npmjs\.org\//i;

// Only a `resolved` value that IS an http(s) URL can be judged against the registry-host allowlist. An npm
// workspace's own local packages (e.g. this repo's `packages/gittensory-mcp`, `apps/gittensory-ui` — see
// `"link": true` entries in package-lock.json) have a `resolved` field that's a RELATIVE FILESYSTEM PATH, not a
// URL at all (e.g. `"packages/gittensory-mcp"`). Such a value was never resolved FROM a registry, so it can't be
// "off-registry" — it must be exempted rather than flagged just because it fails the npmjs.org prefix check.
const HTTP_URL_RE = /^https?:\/\//i;

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
  /** True when THIS SAME package block's own `"version"` line was added and/or removed with a different value
   *  somewhere in the diff (see versionChanged() below for the exact rule). */
  versionChanged: boolean;
  /** A `+resolved` URL seen for this package block that does not point at registry.npmjs.org, or null. Only
   *  ever set for values that ARE http(s) URLs — see HTTP_URL_RE. */
  offRegistryResolvedUrl: string | null;
};

type MutableCandidate = LockfileTamperCandidate & {
  removedVersion: string | undefined;
  addedVersion: string | undefined;
};

/** True when the `"version"` value for a package block genuinely changed within the diff: an added-only or
 *  removed-only version line, or an added+removed pair with different values. Mirrors the same add/remove
 *  reconciliation package.json dependency-range diffing used (before this fix, that was the ONLY signal this
 *  module had) — applied here to the lockfile entry's own version field instead. */
function versionChanged(removed: string | undefined, added: string | undefined): boolean {
  if (removed === undefined && added === undefined) return false;
  return removed !== added;
}

/** Parse one `package-lock.json` unified-diff patch for per-package resolved/integrity/version changes.
 *  Heuristic line-based scan (mirrors review-enrichment's lockfile-drift parser), not a full JSON parse — good
 *  enough to flag suspicious hunks without needing the complete (potentially huge) lockfile tree in memory. */
function scanPackageLockPatch(path: string, patch: string): LockfileTamperCandidate[] {
  const byPackage = new Map<string, MutableCandidate>();
  let currentPackage: string | null = null;
  let sawPackagesEntry = false;

  const entryFor = (pkg: string): MutableCandidate => {
    const existing = byPackage.get(pkg);
    if (existing) return existing;
    const created: MutableCandidate = {
      file: path,
      package: pkg,
      resolvedOrIntegrityChanged: false,
      versionChanged: false,
      offRegistryResolvedUrl: null,
      removedVersion: undefined,
      addedVersion: undefined,
    };
    byPackage.set(pkg, created);
    return created;
  };

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
    const versionMatch = /^"version"\s*:\s*"([^"]*)"/.exec(body);

    if (versionMatch) {
      const entry = entryFor(currentPackage);
      if (line.sign === "+") entry.addedVersion = versionMatch[1];
      else entry.removedVersion = versionMatch[1];
      entry.versionChanged = versionChanged(entry.removedVersion, entry.addedVersion);
      continue;
    }

    if (!resolvedMatch && !integrityMatch) continue;

    const entry = entryFor(currentPackage);
    entry.resolvedOrIntegrityChanged = true;
    if (resolvedMatch && line.sign === "+" && resolvedMatch[1] && HTTP_URL_RE.test(resolvedMatch[1]) && !NPM_REGISTRY_HOST_RE.test(resolvedMatch[1])) {
      entry.offRegistryResolvedUrl = resolvedMatch[1];
    }
  }
  return [...byPackage.values()];
}

const MAX_FLAGGED_PACKAGES_IN_TITLE = 3;

/**
 * Scan every changed `package-lock.json` in the PR for a tamper-risk hunk: a `resolved`/`integrity` value
 * changed for a lockfile entry WITHOUT that same entry's own `"version"` field genuinely changing in the diff,
 * or a `resolved` URL outside `registry.npmjs.org`. Returns ONE `lockfile_tamper_risk` advisory finding on any
 * hit, else null. Callers gate this on the repo's `lockfileIntegrityGateMode` (default `off` — see
 * rules/advisory.ts) before invoking it.
 */
export function lockfileTamperRiskFinding(files: PullRequestFileRecord[]): AdvisoryFinding | null {
  const lockfiles = files.filter((file) => isNpmLockfilePath(file.path));
  if (lockfiles.length === 0) return null;

  const flagged: { file: string; package: string; reason: "off_registry" | "unbumped_resolved" }[] = [];
  for (const file of lockfiles) {
    const patch = typeof file.payload?.patch === "string" ? file.payload.patch : "";
    if (!patch) continue;
    for (const candidate of scanPackageLockPatch(file.path, patch)) {
      if (candidate.offRegistryResolvedUrl) {
        flagged.push({ file: candidate.file, package: candidate.package, reason: "off_registry" });
      } else if (candidate.resolvedOrIntegrityChanged && !candidate.versionChanged) {
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
