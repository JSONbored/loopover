#!/usr/bin/env node
// Reproducible replay-runner image manifest (#9214, epic #8534). Thin IO wrapper over
// replay-runner-image-manifest-core.ts's pure functions -- reads the Dockerfile, its lockfile, and every
// source file the image copies in, then either regenerates the committed manifest or (--check) verifies it
// hasn't drifted. Mirrors backtest-corpus-export.ts's own pure-core / thin-IO split.
//
//   npx tsx scripts/replay-runner-image-manifest.ts            # regenerate and print
//   npx tsx scripts/replay-runner-image-manifest.ts --write    # regenerate and overwrite the committed file
//   npx tsx scripts/replay-runner-image-manifest.ts --check    # fail (exit 1) if the committed file has drifted
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReplayRunnerImageManifest, checkReplayRunnerImageManifestDrift, type ReplayRunnerImageManifest } from "./replay-runner-image-manifest-core";

// Invoked from the repo root, like every other scripts/** CLI (see backtest-corpus-export.ts et al.) --
// process.cwd() is the repo root by convention, not something this script re-derives from its own location.
const REPO_ROOT = process.cwd();
const DOCKERFILE_PATH = "scripts/replay-runner/Dockerfile";
const MANIFEST_PATH = "scripts/replay-runner-image-manifest.json";
const BASE_IMAGE_REF = "node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3";

/** Every source file the Dockerfile's runtime stage copies in, individually enumerated (not a glob) -- see
 *  the Dockerfile's own comment for why this must stay a manually-maintained, exact list: an entry here
 *  drifting from what the Dockerfile actually COPYs is exactly the class of bug this manifest exists to
 *  catch, not something to paper over with a wildcard. */
const SOURCE_FILE_PATHS = [
  "scripts/attested-backtest-run.ts",
  "scripts/attested-backtest-run-core.ts",
  "scripts/backtest-corpus-export-core.ts",
  "scripts/snp-attester.ts",
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function buildFreshManifest(): ReplayRunnerImageManifest {
  const sourceFileContents = Object.fromEntries(SOURCE_FILE_PATHS.map((path) => [path, readRepoFile(path)] as const));
  return buildReplayRunnerImageManifest({
    baseImageRef: BASE_IMAGE_REF,
    dockerfileContent: readRepoFile(DOCKERFILE_PATH),
    packageLockContent: readRepoFile("package-lock.json"),
    sourceFileContents,
  });
}

function main(): void {
  const fresh = buildFreshManifest();

  if (process.argv.includes("--check")) {
    let committedRaw: string;
    try {
      committedRaw = readRepoFile(MANIFEST_PATH);
    } catch {
      process.stderr.write(`${MANIFEST_PATH} does not exist -- run without --check to generate it.\n`);
      process.exit(1);
      return;
    }
    const committed = JSON.parse(committedRaw) as ReplayRunnerImageManifest;
    const result = checkReplayRunnerImageManifestDrift(committed, fresh);
    if (!result.drifted) {
      process.stdout.write("replay-runner image manifest: OK (no drift)\n");
      return;
    }
    process.stderr.write("replay-runner image manifest has DRIFTED (#9214) -- re-run `npm run replay-runner-manifest:write` and commit the result:\n");
    for (const reason of result.reasons) process.stderr.write(`  - ${reason}\n`);
    process.exit(1);
    return;
  }

  const rendered = `${JSON.stringify(fresh, null, 2)}\n`;
  if (process.argv.includes("--write")) {
    writeFileSync(join(REPO_ROOT, MANIFEST_PATH), rendered);
    process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
    return;
  }
  process.stdout.write(rendered);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
