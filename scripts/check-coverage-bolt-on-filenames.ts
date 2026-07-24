#!/usr/bin/env node
// Blocks the "-coverage.test.ts" / "-branch-coverage.test.ts" bolt-on pattern from recurring (#8580,
// epic #8574). A contributor's cheapest path to the 99% Codecov patch-coverage bar is a new file of
// generic "exercises X branches" tests instead of extending the module's existing suite -- that's how
// predicted-gate-engine-coverage.test.ts, reward-risk-engine-branch-coverage.test.ts,
// focus-manifest-engine-branch-coverage.test.ts, and signals-coverage.test.ts all came to exist, each
// requiring a dedicated consolidation PR to undo (#8575/#8577/#8578/#8576). Extend the module's own
// test file instead; if a name below is a genuine exception, add it to ALLOWED_FILENAMES with a reason.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEST_ROOT = "test";
const BOLT_ON_PATTERN = /-(branch-)?coverage\.test\.ts$/;

/** rees-coverage-script.test.ts tests scripts/rees-coverage.js (real coverage-report tooling) -- the
 *  name is a coincidence, not the bolt-on pattern; the "coverage" in its subject IS the point of the file. */
const ALLOWED_FILENAMES = new Set(["rees-coverage-script.test.ts"]);

function defaultListTestFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith(".test.ts"));
}

/** Pure: given the repo's test filenames, returns the bolt-on-named ones that aren't allowlisted.
 *  `listTestFiles` is injectable so tests can simulate a fresh offender without touching the real tree. */
export function findCoverageBoltOnFilenames(options: {
  root?: string;
  listTestFiles?: (root: string) => string[];
} = {}): string[] {
  const { root = TEST_ROOT, listTestFiles = defaultListTestFiles } = options;
  return listTestFiles(root)
    .filter((entry) => BOLT_ON_PATTERN.test(entry.split("/").pop() ?? entry))
    .filter((entry) => !ALLOWED_FILENAMES.has(entry.split("/").pop() ?? entry))
    .sort();
}

function main() {
  const offenders = findCoverageBoltOnFilenames();

  if (offenders.length > 0) {
    console.error(`Found ${offenders.length} "-coverage.test.ts" / "-branch-coverage.test.ts" bolt-on file(s):`);
    for (const offender of offenders) console.error(`  test/${offender}`);
    console.error(
      "\nExtend the module's existing test file instead of adding a new coverage-named bolt-on file " +
        "(see .claude/skills/contributing-to-loopover/reference.md's test-patterns section). If this is a " +
        "genuine exception, add its filename to ALLOWED_FILENAMES in scripts/check-coverage-bolt-on-filenames.ts " +
        "with a one-line reason.",
    );
    process.exit(1);
  }

  console.log('Coverage bolt-on filename check ok: no new "-coverage.test.ts" / "-branch-coverage.test.ts" files.');
}

// Guard so importing this module for its pure export (tests) never triggers the exit side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
