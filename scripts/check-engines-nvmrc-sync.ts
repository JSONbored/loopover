#!/usr/bin/env node
// Verifies every declared `engines.node` range (root + each workspace that declares one) actually
// excludes anything outside the .nvmrc-pinned major version. Every engines.node in this repo used to be
// open-ended (">=22.0.0", no upper bound), so npm never warned or blocked a Node 23+ install locally --
// exactly how the Node 26 jsdom/localStorage gap (nodejs/node#60303) went undetected in
// apps/loopover-miner-ui (#7592/#7597) and then again in apps/loopover-ui + packages/loopover-ui-kit.
// CI itself was never at risk (.github/actions/setup-workspace pins node-version-file: .nvmrc), so this
// only guards local installs -- paired with the root .npmrc's engine-strict=true, which turns an
// out-of-range engines mismatch into a hard npm error instead of a silently-ignored warning.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const ROOT_PACKAGE_JSON = "package.json";
const NVMRC_PATH = ".nvmrc";
const WORKSPACE_GROUPS = ["apps", "packages"];

function defaultReadFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function defaultListDir(root: string, relativePath: string): string[] {
  return readdirSync(join(root, relativePath), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** The .nvmrc pin is a bare major (e.g. "22"), not a full x.y.z -- nvm and actions/setup-node both
 *  resolve it to the latest available patch of that major, so the only thing every engines.node range
 *  must agree on is which major that is. */
function parseNvmrcMajor(nvmrcContent: string): number {
  const trimmed = nvmrcContent.trim().replace(/^v/, "");
  const major = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(major) || major <= 0) {
    throw new Error(`.nvmrc content "${nvmrcContent.trim()}" does not start with a valid major version number`);
  }
  return major;
}

function findWorkspacePackageJsonPaths({ root, listDir }: { root: string; listDir: typeof defaultListDir }): string[] {
  const paths: string[] = [];
  for (const group of WORKSPACE_GROUPS) {
    let entries: string[];
    try {
      entries = listDir(root, group);
    } catch {
      continue; // no apps/ or packages/ dir at all -- nothing to enumerate
    }
    for (const name of entries) paths.push(`${group}/${name}/package.json`);
  }
  return paths;
}

export function checkEnginesNvmrcSync({
  root,
  readFile = defaultReadFile,
  listDir = defaultListDir,
}: {
  root: string;
  readFile?: typeof defaultReadFile;
  listDir?: typeof defaultListDir;
}): {
  failures: string[];
  nvmrcMajor: number;
  checkedPackages: string[];
} {
  const nvmrcMajor = parseNvmrcMajor(readFile(root, NVMRC_PATH));
  const nextMajorFloor = `${nvmrcMajor + 1}.0.0`;

  const candidatePaths = [ROOT_PACKAGE_JSON, ...findWorkspacePackageJsonPaths({ root, listDir })];
  const failures: string[] = [];
  const checkedPackages: string[] = [];

  for (const packageJsonPath of candidatePaths) {
    let manifest: { engines?: { node?: string } };
    try {
      manifest = JSON.parse(readFile(root, packageJsonPath));
    } catch {
      continue; // a workspace dir with no (or unreadable) package.json isn't this check's concern
    }
    const nodeRange = manifest.engines?.node;
    if (!nodeRange) continue; // only packages that opt in to an engines.node pin are validated

    checkedPackages.push(packageJsonPath);
    if (!semver.validRange(nodeRange)) {
      failures.push(`${packageJsonPath}: engines.node "${nodeRange}" is not a valid semver range.`);
      continue;
    }
    if (semver.satisfies(nextMajorFloor, nodeRange)) {
      failures.push(
        `${packageJsonPath}: engines.node "${nodeRange}" still allows Node ${nextMajorFloor} -- .nvmrc pins ` +
          `major ${nvmrcMajor}, so the range needs an upper bound excluding ${nvmrcMajor + 1}.0.0 and above ` +
          `(e.g. ">=${nvmrcMajor}.0.0 <${nvmrcMajor + 1}.0.0").`,
      );
    }
  }

  return { failures, nvmrcMajor, checkedPackages };
}

function main() {
  const { failures, nvmrcMajor, checkedPackages } = checkEnginesNvmrcSync({ root: process.cwd() });

  if (failures.length > 0) {
    console.error(`Engines/.nvmrc sync check found ${failures.length} issue(s) (nvmrc major: ${nvmrcMajor}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Engines/.nvmrc sync check ok: ${checkedPackages.length} package(s) with an engines.node pin all exclude Node ${nvmrcMajor + 1}+.`);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
