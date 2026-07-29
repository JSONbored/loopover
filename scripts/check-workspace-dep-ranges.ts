#!/usr/bin/env node
// A workspace dependency's range must actually match the workspace version it points at.
//
// THE INCIDENT: `apps/loopover-ui` declared `"@loopover/contract": "^0.1.0"`. While the contract package
// sat at 0.1.0 that range matched the workspace copy, so npm linked it and everything was fine. The moment
// release-please bumped contract into the engine-and-dependents group at 3.17.0, `^0.1.0` stopped matching
// -- and npm did NOT fail. It quietly resolved the dependency from the REGISTRY instead, installing the
// published 0.1.0 tarball into apps/loopover-ui/node_modules while every other consumer used 3.17.0.
//
// The website would then have built against a contract nearly twenty minor versions stale: same import
// specifier, different schemas and types, no error anywhere. It surfaced only as an `npm ci` lockfile-sync
// failure on the release PR, which reads like a mechanical lockfile problem rather than the dependency bug
// it actually is.
//
// So: every dependency on a workspace package must be satisfied by that package's CURRENT version. `*` is
// the honest way for a PRIVATE app to say "always the workspace copy" and is accepted as such. A published
// package cannot use `*` (real consumers install it from npm and need a meaningful range), so those must
// keep a range that genuinely matches -- which the same check enforces.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { satisfies, validRange } from "semver";

export type WorkspaceManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  path?: string;
};

export type RangeViolation = { consumer: string; dependency: string; range: string; workspaceVersion: string; reason: string };

/**
 * PURE core: every workspace-internal dependency whose range the workspace version does not satisfy.
 *
 * `*` is exempt by design -- it is the explicit "whatever the workspace has" declaration, and the only
 * range that cannot drift. Non-workspace (third-party) dependencies are ignored entirely: their versions
 * come from the registry and the lockfile, which is a different problem with different guards.
 */
export function findWorkspaceRangeDrift(manifests: readonly WorkspaceManifest[]): RangeViolation[] {
  const versions = new Map<string, string>();
  for (const manifest of manifests) {
    if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
  }

  const violations: RangeViolation[] = [];
  for (const manifest of manifests) {
    const consumer = manifest.name ?? manifest.path ?? "<unnamed>";
    for (const section of ["dependencies", "devDependencies"] as const) {
      for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
        const workspaceVersion = versions.get(dependency);
        if (workspaceVersion === undefined) continue; // third-party: not ours to police
        if (range === "*") continue; // explicitly "the workspace copy", cannot drift
        // A PRIVATE package is never installed from a registry, so a pinned range buys it nothing and can
        // only rot. Requiring "*" here is what makes this check catch the trap BEFORE the bump that springs
        // it: `^0.1.0` against contract@0.1.0 is satisfied today and silently wrong the day contract is
        // bumped, which is exactly how apps/loopover-ui ended up resolving a stale published copy.
        if (manifest.private) {
          violations.push({
            consumer,
            dependency,
            range,
            workspaceVersion,
            reason: `${consumer} is private, so it is never installed from a registry -- pin it to "*" instead of "${range}", which buys nothing and breaks silently the next time ${dependency} is version-bumped`,
          });
          continue;
        }
        if (!validRange(range)) {
          violations.push({
            consumer,
            dependency,
            range,
            workspaceVersion,
            reason: `"${range}" is not a valid semver range, so npm's resolution here is unpredictable`,
          });
          continue;
        }
        if (!satisfies(workspaceVersion, range)) {
          violations.push({
            consumer,
            dependency,
            range,
            workspaceVersion,
            reason: `the workspace has ${dependency}@${workspaceVersion}, which "${range}" does NOT match -- npm will silently install a published copy from the registry instead of linking the workspace one`,
          });
        }
      }
    }
  }
  return violations;
}

function readManifests(root: string): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [];
  for (const group of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue; // a workspace group that does not exist here is not an error
    }
    for (const name of entries) {
      const path = join(group, name, "package.json");
      try {
        manifests.push({ ...(JSON.parse(readFileSync(join(root, path), "utf8")) as WorkspaceManifest), path });
      } catch {
        // A directory without a manifest is not a workspace package; skip rather than fail the check.
      }
    }
  }
  return manifests;
}

function main(): void {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const violations = findWorkspaceRangeDrift(readManifests(root));

  if (violations.length > 0) {
    console.error("A workspace dependency's range no longer matches the package it points at:\n");
    for (const violation of violations) {
      console.error(`  ${violation.consumer} -> "${violation.dependency}": "${violation.range}"`);
      console.error(`    ${violation.reason}`);
    }
    console.error(
      "\n  npm does NOT fail on this. It resolves the dependency from the registry instead, so the consumer\n" +
        "  silently builds against a published copy while the rest of the repo uses the workspace one.\n\n" +
        "  For a PRIVATE app: use \"*\" -- it means \"the workspace copy\" and cannot drift.\n" +
        "  For a PUBLISHED package: widen the range to include the current workspace version, since real\n" +
        "  consumers install it from npm and need a range that means something.",
    );
    process.exit(1);
  }
  console.log("workspace-dep-ranges: OK — every workspace dependency resolves to the workspace copy.");
}

if (process.argv[1]?.endsWith("check-workspace-dep-ranges.ts")) main();
