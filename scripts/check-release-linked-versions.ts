#!/usr/bin/env node
// Enforces the two release-config invariants that are otherwise only remembered, both of which have
// already been broken silently in this repo.
//
// (1) LINKED-VERSIONS COVERAGE. mcp-release-please.yml's header explains the failure at length: when
// one release-please component carries a real dependency on another, node-workspace bumps the
// dependent's version range the moment the prerequisite's version changes -- but under
// separate-pull-requests: true that bump lands on the dependent's OWN branch, so its package.json
// requires a version that exists nowhere (not locally, since the prerequisite's bump is on a
// different unmerged branch; not on npm, since it hasn't published). `npm ci` then fails ETARGET.
// Confirmed live across several mcp/miner cycles (#7086/#7087/#7107/#7108/#7119/#7120/#7121).
// node-workspace's own `merge` option does NOT override separate-pull-requests; the linked-versions
// plugin is the only mechanism that does, and only for the components named in its group.
//
// That makes group membership a function of the DEPENDENCY GRAPH, not of release cadence -- and
// nothing enforced it. #9521 introduced @loopover/contract as a runtime dependency of both
// @loopover/mcp and @loopover/miner without adding it to the group, and that went unnoticed until
// #9749; the package was not even published, so the next mcp/miner release would have shipped
// uninstallable. This check derives the required grouping from the real package.json edges so the
// next such edge fails CI instead of a release.
//
// (2) MANIFEST COVERAGE. sync-release-manifest.ts derives its work list from
// .release-please-manifest.json's OWN keys and skips any workspace it doesn't already track
// (`if (!(workspacePath in manifest)) continue`). A package added to release-please-config.json but
// not to the manifest is therefore silently exempt from the staleness check that exists to stop
// release-please re-proposing an already-published version. Adding a package to one file and not
// the other is a one-line mistake with no feedback, so it is checked here.
//
// PURE core + thin IO, mirroring sync-release-manifest.ts's own split so the logic is unit-testable
// without touching the filesystem.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CONFIG_PATH = "release-please-config.json";
export const MANIFEST_PATH = ".release-please-manifest.json";

/** Dependency fields that SHIP to a consumer and so can break an install of the published package,
 *  not just a workspace `npm ci`. `devDependencies` is deliberately excluded: it never reaches a
 *  consumer, and forcing two packages into permanent version lockstep over a build-time-only edge
 *  costs more than the failure it would prevent (which surfaces immediately in CI on the branch that
 *  introduced it, rather than in a published artifact). If a devDependency edge ever does cause a
 *  release failure, this comment is the record of the tradeoff that allowed it. */
export const SHIP_AFFECTING_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

export type ReleaseConfig = {
  packages: Record<string, { component?: string; "package-name"?: string }>;
  plugins?: unknown[];
};

export type PackageManifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export type LinkedVersionsViolation =
  | { kind: "missing_manifest_entry"; workspacePath: string }
  | { kind: "unlinked_dependency_edge"; fromPackage: string; toPackage: string; field: string; fromGroup: string | null; toGroup: string | null };

/** Component -> linked-versions group name, for every component named in any linked-versions plugin. */
export function linkedVersionGroups(config: ReleaseConfig): Map<string, string> {
  const groups = new Map<string, string>();
  for (const plugin of config.plugins ?? []) {
    if (typeof plugin !== "object" || plugin === null) continue;
    const entry = plugin as { type?: unknown; groupName?: unknown; components?: unknown };
    if (entry.type !== "linked-versions" || !Array.isArray(entry.components)) continue;
    const groupName = typeof entry.groupName === "string" ? entry.groupName : "<unnamed>";
    for (const component of entry.components) {
      if (typeof component === "string") groups.set(component, groupName);
    }
  }
  return groups;
}

/**
 * PURE. Returns every violation of the two invariants above. `packageJsons` is keyed by the same
 * workspace paths release-please-config.json uses.
 */
export function checkReleaseLinkedVersions(input: {
  config: ReleaseConfig;
  manifestKeys: readonly string[];
  packageJsons: Record<string, PackageManifest>;
}): LinkedVersionsViolation[] {
  const { config, manifestKeys, packageJsons } = input;
  const violations: LinkedVersionsViolation[] = [];
  const trackedPaths = Object.keys(config.packages ?? {});
  const manifestSet = new Set(manifestKeys);

  for (const workspacePath of trackedPaths) {
    if (!manifestSet.has(workspacePath)) violations.push({ kind: "missing_manifest_entry", workspacePath });
  }

  const groups = linkedVersionGroups(config);
  // Published package name -> its release-please component, for tracked packages only. An edge to a
  // package release-please does not track cannot race a release, so it is not this check's business.
  const componentByPackageName = new Map<string, string>();
  for (const workspacePath of trackedPaths) {
    const name = packageJsons[workspacePath]?.name;
    const component = config.packages[workspacePath]?.component;
    if (typeof name === "string" && typeof component === "string") componentByPackageName.set(name, component);
  }

  for (const workspacePath of trackedPaths) {
    const pkg = packageJsons[workspacePath];
    const fromName = pkg?.name;
    const fromComponent = config.packages[workspacePath]?.component;
    if (!pkg || typeof fromName !== "string" || typeof fromComponent !== "string") continue;
    for (const field of SHIP_AFFECTING_DEPENDENCY_FIELDS) {
      for (const depName of Object.keys(pkg[field] ?? {})) {
        const toComponent = componentByPackageName.get(depName);
        if (toComponent === undefined) continue; // not a release-please-tracked package
        const fromGroup = groups.get(fromComponent) ?? null;
        const toGroup = groups.get(toComponent) ?? null;
        if (fromGroup === null || toGroup === null || fromGroup !== toGroup) {
          violations.push({ kind: "unlinked_dependency_edge", fromPackage: fromName, toPackage: depName, field, fromGroup, toGroup });
        }
      }
    }
  }

  return violations;
}

export type CheckIo = {
  readFileSync: (path: string, encoding: string) => string;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function main(
  io: CheckIo = {
    readFileSync: (path: string, encoding: string) => readFileSync(path, encoding as BufferEncoding),
    log: console.log.bind(console),
    error: console.error.bind(console),
    exit: (code: number) => process.exit(code),
  },
): number {
  const config = JSON.parse(io.readFileSync(CONFIG_PATH, "utf8")) as ReleaseConfig;
  const manifestKeys = Object.keys(JSON.parse(io.readFileSync(MANIFEST_PATH, "utf8")));
  const trackedPaths = Object.keys(config.packages ?? {});
  const packageJsons = Object.fromEntries(
    trackedPaths.map((workspacePath) => [workspacePath, JSON.parse(io.readFileSync(`${workspacePath}/package.json`, "utf8")) as PackageManifest]),
  );

  const violations = checkReleaseLinkedVersions({ config, manifestKeys, packageJsons });
  for (const violation of violations) {
    if (violation.kind === "missing_manifest_entry") {
      io.error(`${MANIFEST_PATH}: missing an entry for ${violation.workspacePath}, which ${CONFIG_PATH} tracks.`);
      io.error(`  sync-release-manifest.ts skips workspaces the manifest doesn't already list, so this package is silently exempt from its staleness check.`);
    } else {
      io.error(`${CONFIG_PATH}: ${violation.fromPackage} depends on ${violation.toPackage} (${violation.field}), but they are not in the same linked-versions group.`);
      io.error(`  ${violation.fromPackage} group: ${violation.fromGroup ?? "<none>"} | ${violation.toPackage} group: ${violation.toGroup ?? "<none>"}`);
    }
  }
  if (violations.length > 0) {
    io.error(
      `check-release-linked-versions: ${violations.length} violation(s). A dependency edge between release-please components MUST sit inside one linked-versions group, or the dependent's release PR will require a version that exists nowhere and fail ETARGET on npm ci (see mcp-release-please.yml's header).`,
    );
    io.exit(1);
    return 1;
  }
  io.log(`check-release-linked-versions: ${trackedPaths.length} tracked package(s), all dependency edges linked and manifest-tracked.`);
  return 0;
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
