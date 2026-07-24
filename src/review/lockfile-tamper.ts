// Lockfile-tamper-risk gate check (#2563). Deterministic scan of a changed `package-lock.json` diff (npm
// only — see isNpmLockfilePath below; yarn.lock/pnpm-lock.yaml are not parsed) for the classic supply-chain
// tell: a `resolved`/`integrity` value changed WITHOUT that
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

// Only a `resolved` value that IS a URL can be judged against the registry-host allowlist. An npm
// workspace's own local packages (e.g. this repo's `packages/loopover-mcp`, `apps/loopover-ui` — see
// `"link": true` entries in package-lock.json) have a `resolved` field that's a RELATIVE FILESYSTEM PATH, not a
// URL at all (e.g. `"packages/loopover-mcp"`). Such a value was never resolved FROM a registry, so it can't be
// "off-registry" — it must be exempted rather than flagged just because it fails the npmjs.org prefix check.
// Remote npm lockfile entries are not limited to http(s): git+ssh://, git+https://, ssh://, and similar URL
// schemes still fetch outside the npm registry and must stay visible to the supply-chain gate.
const RESOLVED_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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

/** Recover a bare package name from an npm-registry `resolved` URL (e.g. context lines in a hunk whose
 *  `"node_modules/<pkg>": {` header fell outside git's 3-line window). Used to key unattributed fallback
 *  buckets so version + resolved/integrity signals for the SAME package can merge across hunk boundaries
 *  (#8351) instead of each depth-0 `}` minting a fresh `#unattributed-N` sequence key. */
function packageNameFromResolvedUrl(url: string): string | null {
  const match = /^https:\/\/registry\.npmjs\.org\/((?:@[^/]+\/)?[^/]+)\//i.exec(url);
  return match?.[1] ?? null;
}

/** True when `path`'s basename is `package-lock.json` — the only lockfile format this check parses today
 *  (npm/lockfileVersion 2-3 JSON shape). Matches ANY directory depth (root, `review-enrichment/`,
 *  `apps/loopover-ui/`, or a future workspace) rather than a hardcoded path list, so a new workspace package
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
   *  ever set for values that ARE URLs — see RESOLVED_URL_RE. */
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
  return removed !== added;
}

/** Parse one `package-lock.json` unified-diff patch for per-package resolved/integrity/version changes.
 *  Heuristic line-based scan (mirrors review-enrichment's lockfile-drift parser), not a full JSON parse — good
 *  enough to flag suspicious hunks without needing the complete (potentially huge) lockfile tree in memory.
 *
 *  Keyed by the FULL lockfile-entry path (e.g. `node_modules/bar/node_modules/foo`), not the bare package name
 *  (see #2563 gate-review follow-up on #2692): a package can appear as MULTIPLE distinct lockfileVersion 2/3
 *  entries under different nesting paths when different dependents require incompatible versions of it. Keying
 *  by bare name merged those distinct entries into one shared record, so a genuine version bump on one entry
 *  could mask an unbumped resolved/integrity edit on a DIFFERENT entry of the same package -- the full
 *  `node_modules/...` path IS unique per entry (npm packages a duplicate copy under a distinct nested path
 *  precisely because two entries with the same bare name coexist), so using it as the map key keeps every
 *  entry's own signal independent. The bare package name is still recorded separately for display. The legacy
 *  lockfileVersion 1 "dependencies" tree (bare, non-path keys — see npmPackageFromNodeModulesPath's fallback)
 *  has no such embedded full path and keeps its pre-existing bare-name keying; that format predates any
 *  actively maintained repo's lockfile and is out of scope here. */
function scanPackageLockPatch(path: string, patch: string): LockfileTamperCandidate[] {
  const byEntry = new Map<string, MutableCandidate>();
  let activeEntry: { entryKey: string; packageName: string } | null = null;
  let innerObjectDepth = 0;
  let sawPackagesEntry = false;
  // True immediately after a header line is explicitly identified as NOT a real package entry (a
  // container wrapper like "dependencies", or a bare key once we're already in node_modules/-keyed
  // territory) -- suppresses the unattributed-entry fallback below for that block's own contents, so
  // a deliberately-skipped key (see the "node_modules/" with nothing after the marker case) stays
  // skipped rather than getting swept into a fallback bucket. Cleared by the next real header or a
  // depth-0 close brace.
  let insideRejectedBlock = false;
  // Fallback bucket for a resolved/integrity/version change whose entry header isn't visible ANYWHERE
  // in the diff -- git's default 3-line context doesn't guarantee an entry's opening-brace line
  // survives when the changed field sits deeper than 3 lines into the entry (#7778). Without this, such
  // a change was silently dropped: `currentEntryKey` stayed null for the whole hunk, so the
  // `!currentEntryKey ... continue` guard below skipped it -- a tampered field could evade detection
  // entirely just by having enough unchanged sibling fields ahead of it in its entry.
  //
  // When a package name can be recovered from a nearby `resolved` URL (including unchanged context
  // lines), the fallback key is `${path}#unattributed:<pkg>` so two hunks that each close with a
  // depth-0 `}` (which clears `activeUnknownKey`) still merge into ONE candidate for that package
  // (#8351). Without a recoverable name we keep the per-block `#unattributed-N` sequence — two
  // genuinely different nameless blocks must never collapse into each other.
  let activeUnknownKey: string | null = null;
  let unknownEntrySeq = 0;
  let inferredUnattributedPackage: string | null = null;

  const entryFor = (entryKey: string, packageName: string): MutableCandidate => {
    const existing = byEntry.get(entryKey);
    if (existing) return existing;
    const created: MutableCandidate = {
      file: path,
      package: packageName,
      resolvedOrIntegrityChanged: false,
      versionChanged: false,
      offRegistryResolvedUrl: null,
      removedVersion: undefined,
      addedVersion: undefined,
    };
    byEntry.set(entryKey, created);
    return created;
  };

  const clearBlockTracking = () => {
    activeEntry = null;
    insideRejectedBlock = false;
    activeUnknownKey = null;
    inferredUnattributedPackage = null;
  };

  /** When a sequence-keyed unattributed bucket later learns a package name, re-key (and merge into any
   *  pre-existing package-keyed candidate) so cross-hunk / late-resolved correlation works (#8351). */
  const promoteSequenceKeyToPackage = (packageName: string) => {
    if (!activeUnknownKey?.includes("#unattributed-")) return;
    const seqKey = activeUnknownKey;
    const pkgKey = `${path}#unattributed:${packageName}`;
    activeUnknownKey = pkgKey;
    const seqEntry = byEntry.get(seqKey);
    // Freshly minted sequence keys promote before their first field is recorded — no map entry yet.
    if (!seqEntry) return;
    const prior = byEntry.get(pkgKey);
    if (!prior) {
      byEntry.delete(seqKey);
      byEntry.set(pkgKey, seqEntry);
      return;
    }
    if (seqEntry.removedVersion !== undefined) prior.removedVersion = seqEntry.removedVersion;
    if (seqEntry.addedVersion !== undefined) prior.addedVersion = seqEntry.addedVersion;
    prior.versionChanged = versionChanged(prior.removedVersion, prior.addedVersion);
    prior.resolvedOrIntegrityChanged = prior.resolvedOrIntegrityChanged || seqEntry.resolvedOrIntegrityChanged;
    prior.offRegistryResolvedUrl = prior.offRegistryResolvedUrl ?? seqEntry.offRegistryResolvedUrl;
    byEntry.delete(seqKey);
  };

  for (const line of patchLines(patch)) {
    const body = line.content.trim();
    const objectHeader = /^"([^"]+)"\s*:\s*\{/.exec(body);
    if (objectHeader) {
      const key = objectHeader[1]!;
      const nodeModulesPackage = npmPackageFromNodeModulesPath(key);
      if (nodeModulesPackage) {
        activeEntry = { entryKey: key, packageName: nodeModulesPackage };
        innerObjectDepth = 0;
        sawPackagesEntry = true;
        insideRejectedBlock = false;
        activeUnknownKey = null;
        inferredUnattributedPackage = null;
      } else if (activeEntry) {
        innerObjectDepth++;
      } else if (!sawPackagesEntry && !CONTAINER_KEYS.has(key)) {
        activeEntry = { entryKey: key, packageName: key };
        innerObjectDepth = 0;
        insideRejectedBlock = false;
        activeUnknownKey = null;
        inferredUnattributedPackage = null;
      } else {
        activeEntry = null;
        innerObjectDepth = 0;
        insideRejectedBlock = true;
        activeUnknownKey = null;
        inferredUnattributedPackage = null;
      }
      continue;
    }
    if (body === "}" || body.startsWith("},")) {
      if (innerObjectDepth > 0) {
        innerObjectDepth--;
      } else {
        clearBlockTracking();
      }
    }

    const resolvedMatch = /^"resolved"\s*:\s*"([^"]*)"/.exec(body);
    const integrityMatch = /^"integrity"\s*:\s*"([^"]*)"/.exec(body);
    const versionMatch = /^"version"\s*:\s*"([^"]*)"/.exec(body);

    // Learn package identity from ANY resolved URL in this block (context OR changed) before deciding
    // the unattributed bucket key — a version-only hunk's leading context often still carries the
    // registry URL even when the entry header itself is out of window (#8351 / #7778).
    if (!activeEntry && !insideRejectedBlock && resolvedMatch?.[1]) {
      const fromResolved = packageNameFromResolvedUrl(resolvedMatch[1]);
      if (fromResolved) {
        inferredUnattributedPackage = fromResolved;
        // Context lines never reach the allocation branch below; still promote a live sequence key.
        promoteSequenceKeyToPackage(fromResolved);
      }
    }

    let currentEntryKey = activeEntry?.entryKey ?? null;
    let currentPackageName = activeEntry?.packageName ?? null;
    if (!currentEntryKey && !insideRejectedBlock && line.sign !== " " && (resolvedMatch || integrityMatch || versionMatch)) {
      // Always mint a sequence key first, then promote to `#unattributed:<pkg>` when a name is known
      // (covers the empty-bucket promote path on first allocation, and late re-key once fields exist).
      if (!activeUnknownKey) {
        unknownEntrySeq += 1;
        activeUnknownKey = `${path}#unattributed-${unknownEntrySeq}`;
      }
      if (inferredUnattributedPackage) {
        promoteSequenceKeyToPackage(inferredUnattributedPackage);
      }
      currentEntryKey = activeUnknownKey;
      // Keep the anonymous display label even when the Map key is package-qualified — existing #7778
      // assertions (and the public finding text for header-less hunks) key off this exact string.
      currentPackageName = "(unattributed lockfile entry)";
    }
    if (!currentEntryKey || !currentPackageName || line.sign === " ") continue;

    if (versionMatch) {
      const entry = entryFor(currentEntryKey, currentPackageName);
      // `line.sign` is guaranteed "+" or "-" here (never " ") by the `line.sign === " "` continue above -- a
      // context ("unchanged") "version" line never reaches this branch, so it can never masquerade as removed.
      if (line.sign === "+") entry.addedVersion = versionMatch[1];
      else entry.removedVersion = versionMatch[1];
      entry.versionChanged = versionChanged(entry.removedVersion, entry.addedVersion);
      continue;
    }

    if (!resolvedMatch && !integrityMatch) continue;

    const entry = entryFor(currentEntryKey, currentPackageName);
    entry.resolvedOrIntegrityChanged = true;
    if (resolvedMatch && line.sign === "+" && resolvedMatch[1] && RESOLVED_URL_RE.test(resolvedMatch[1]) && !NPM_REGISTRY_HOST_RE.test(resolvedMatch[1])) {
      entry.offRegistryResolvedUrl = resolvedMatch[1];
    }
  }
  return [...byEntry.values()];
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
  if (hasUnbumped) detailParts.push("a resolved/integrity value changed without a matching version bump in the lockfile entry itself");

  return {
    code: "lockfile_tamper_risk",
    severity: "warning",
    title: `Possible lockfile tamper risk (${shownNames}${moreSuffix})`,
    detail: `The lockfile diff for ${[...new Set(flagged.map((f) => f.file))].join(", ")} is suspicious: ${detailParts.join("; ")}. Affected package(s): ${names.join(", ")}.`,
    action: "Re-run the package manager's install/lock command to regenerate the lockfile from package.json rather than hand-editing resolved/integrity entries, and confirm every resolved URL is on the public npm registry.",
  };
}
