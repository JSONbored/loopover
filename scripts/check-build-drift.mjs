#!/usr/bin/env node
// packages/loopover-{miner,mcp} both compile real TypeScript in place (tsc's outDir === rootDir, so
// e.g. lib/foo.ts emits lib/foo.js + lib/foo.d.ts right next to it) and commit that emitted output --
// both packages ship as installable CLIs (npm install -g), so a runnable .js has to exist in the
// published tarball, and root-level tests import the emitted .js by its literal specifier (NodeNext
// resolution), not the .ts source, so a stale commit makes test:coverage silently exercise old
// behavior instead of loudly failing. package.json composes this AFTER the package's real build
// (`npm run build:{miner,mcp} && node scripts/check-build-drift.mjs {miner,mcp}`) -- this script's own
// job is just: did that build change anything relative to what's committed. Mirrors cf-typegen:check's
// "regenerate for real, then diff" shape for a package whose generated output is emitted in place
// across a whole directory rather than to one named file.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_PATHS = {
  miner: ["packages/loopover-miner/bin", "packages/loopover-miner/lib"],
  mcp: ["packages/loopover-mcp/bin", "packages/loopover-mcp/lib"],
};

/** The bin/lib directories a package name checks. Exported (rather than inlined into main()) so a test
 *  can validate the real PACKAGE_PATHS table itself -- e.g. that "miner" resolves to real repo paths --
 *  not just a fake stand-in for it. Throws on an unknown name instead of silently checking nothing. */
export function pathsForPackage(name) {
  const paths = PACKAGE_PATHS[name];
  if (!paths) {
    throw new Error(`check-build-drift: unknown package "${name}" (expected one of: ${Object.keys(PACKAGE_PATHS).join(", ")})`);
  }
  return paths;
}

function defaultGitStatus(paths, cwd) {
  return execFileSync("git", ["status", "--porcelain", "--", ...paths], { cwd, encoding: "utf8" });
}

/** Trimmed `git status --porcelain` text for `paths` under `cwd` (a real git worktree) -- "" when
 *  clean. Porcelain (not plain `git diff --exit-code`) deliberately: a .ts file whose emitted .js/.d.ts
 *  was never committed at all shows up as an untracked file, which `git diff` alone never reports.
 *  `run` is injectable so tests can fake the git call entirely; the default shells out for real. */
export function checkBuildDrift(paths, { cwd = process.cwd(), run = defaultGitStatus } = {}) {
  return run(paths, cwd).trim();
}

export function main(argv) {
  try {
    const name = argv[0];
    const paths = pathsForPackage(name);
    const drift = checkBuildDrift(paths);
    if (drift.length > 0) {
      process.stderr.write(
        `check-build-drift: packages/loopover-${name}'s committed .js/.d.ts is stale relative to its .ts source -- run \`npm run build:${name}\` and commit the result:\n${drift}\n`,
      );
      process.exit(1);
      return;
    }
    process.stdout.write(`check-build-drift: packages/loopover-${name}'s committed .js/.d.ts matches its .ts source.\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
