#!/usr/bin/env node
// A published package must not depend on an unpublishable one (#9749).
//
// @loopover/contract was split out by #9521 and became a RUNTIME dependency of both published CLIs
// (@loopover/mcp and @loopover/miner import it from code that ships, built with plain tsc so the specifiers
// survive into the emitted JS) -- but it had no publish workflow, so it was never on npm. Nothing caught
// that, because the failure is invisible until the NEXT release: the currently-published CLI versions
// predate the dependency and install fine. The first user to run `npm install -g @loopover/mcp@latest`
// after that release gets E404, and by then the broken version is already public and immutable.
//
// This is the check that would have failed the moment the dependency was added. It is deliberately about
// the CLASS, not about `@loopover/contract`: any future workspace package that becomes a runtime dependency
// of a published one is caught the same way, with no list to remember to update.
//
// WHAT "RELEASABLE" MEANS HERE: listed in `release-please-config.json` AND carrying a
// `.github/workflows/publish-<name>.yml`. Both, because they fail differently and both failures ship the
// same broken tarball: a package absent from release-please never gets a version bump or a changelog entry
// (so consumers pin a range that is never satisfied), and a package with no publish workflow never reaches
// npm at all. Deriving both from the files themselves, rather than a hand-maintained list, is what keeps
// this honest when a fifth package is added.
//
// WHAT IT DOES NOT CHECK: ordering between two publishes. A contract release must go out BEFORE an mcp
// release that depends on a new version of it, and no static check can see that -- it stays a
// release-runbook step, called out in publish-contract.yml's own header.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

export type PackageManifest = { name?: string; private?: boolean; dependencies?: Record<string, string> };

/** One violation, phrased as the failure it will cause rather than as a rule number. */
export type PublishableDepViolation = { publishedPackage: string; dependency: string; range: string; reason: string };

/**
 * PURE core: given every workspace manifest and the set of packages that have a publish workflow, name every
 * runtime dependency of a published package that cannot itself be installed from npm.
 *
 * Only `dependencies` are walked. A `devDependency` is not shipped in the tarball and cannot break an
 * end user's install, so flagging one would be noise -- and would push contributors toward the wrong fix.
 */
export function findPublishableDepViolations(
  manifests: readonly PackageManifest[],
  publishedNames: ReadonlySet<string>,
  releasePleaseNames: ReadonlySet<string> = publishedNames,
): PublishableDepViolation[] {
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name).filter((name): name is string => Boolean(name)));
  const privateNames = new Set(manifests.filter((manifest) => manifest.private).map((manifest) => manifest.name));
  const violations: PublishableDepViolation[] = [];

  for (const manifest of manifests) {
    if (!manifest.name || !publishedNames.has(manifest.name)) continue;
    for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
      // Only WORKSPACE packages can be unpublishable in this way; a third-party dependency is on npm by
      // definition of being installable at all.
      if (!workspaceNames.has(dependency)) continue;
      if (privateNames.has(dependency)) {
        violations.push({
          publishedPackage: manifest.name,
          dependency,
          range,
          reason: `${dependency} is marked private and can never be published`,
        });
        continue;
      }
      if (!publishedNames.has(dependency)) {
        violations.push({
          publishedPackage: manifest.name,
          dependency,
          range,
          reason: `${dependency} has no .github/workflows/publish-*.yml, so it is not published to npm`,
        });
        continue;
      }
      // Registered for publishing but not for RELEASING: it would never get a version bump or a changelog
      // entry, so a consumer's range could never be satisfied by a new release.
      if (!releasePleaseNames.has(dependency)) {
        violations.push({
          publishedPackage: manifest.name,
          dependency,
          range,
          reason: `${dependency} is missing from release-please-config.json, so it is never version-bumped or released`,
        });
      }
    }
  }
  return violations;
}

/** Map `publish-<slug>.yml` to the package name it publishes, by reading the workflow's own filter. Derived
 *  rather than assumed from the filename: `publish-ui-kit.yml` publishes `@loopover/ui-kit`, and a future
 *  workflow could name its package anything. */
export function publishedPackageNames(workflowFiles: ReadonlyArray<{ name: string; text: string }>): Set<string> {
  const names = new Set<string>();
  for (const file of workflowFiles) {
    if (!/^publish-.+\.ya?ml$/.test(file.name)) continue;
    for (const match of file.text.matchAll(/@loopover\/[a-z0-9-]+/g)) names.add(match[0]);
  }
  return names;
}

function main(): void {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const packagesDir = join(root, "packages");
  const manifests: PackageManifest[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(JSON.parse(readFileSync(join(packagesDir, entry.name, "package.json"), "utf8")) as PackageManifest);
    } catch {
      // A directory without a manifest is not a workspace package; skip rather than fail the whole check.
    }
  }

  const workflowsDir = join(root, ".github", "workflows");
  const workflowFiles = readdirSync(workflowsDir)
    .filter((name) => /^publish-.+\.ya?ml$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(workflowsDir, name), "utf8") }));

  const published = publishedPackageNames(workflowFiles);
  const releaseConfig = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8")) as {
    packages?: Record<string, { "package-name"?: string }>;
  };
  const releasePleaseNames = new Set(
    Object.values(releaseConfig.packages ?? {})
      .map((entry) => entry["package-name"])
      .filter((name): name is string => Boolean(name)),
  );
  const violations = findPublishableDepViolations(manifests, published, releasePleaseNames);

  if (violations.length > 0) {
    console.error("check-publishable-deps: a PUBLISHED package depends on something users cannot install:\n");
    for (const violation of violations) {
      console.error(`  ${violation.publishedPackage} -> "${violation.dependency}": "${violation.range}"`);
      console.error(`    ${violation.reason}`);
    }
    console.error(
      "\n  The next release of that package would publish an uninstallable tarball (npm E404 for every\n" +
        "  external user), and a published version cannot be taken back. Fix by adding a\n" +
        "  .github/workflows/publish-<name>.yml for the dependency, bundling it into the consumer, or\n" +
        "  demoting it to a devDependency if it is genuinely not needed at runtime. A package must be in BOTH\n" +
        "  release-please-config.json and a publish workflow to count as releasable.",
    );
    process.exit(1);
  }
  console.log(
    `check-publishable-deps: OK — ${published.size} published package(s), ${releasePleaseNames.size} release-please-registered, no runtime dependency on an unreleasable workspace package.`,
  );
}

if (process.argv[1]?.endsWith("check-publishable-deps.ts")) main();
