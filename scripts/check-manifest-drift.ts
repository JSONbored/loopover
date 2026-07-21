#!/usr/bin/env node
// Cross-checks the bundled fallback YAML in src/config/loopover-repo-focus-manifest.ts
// (LOOPOVER_REPO_FOCUS_MANIFEST_YAML) against the real root .loopover.yml. The bundled string exists so
// the focus-manifest engine still has a sane default when the live repo file is unreachable (local dev,
// pre-merge branches) -- see that file's own header comment -- but nothing in CI previously caught the two
// silently diverging once someone edited one and forgot the other. This script parses both with the `yaml`
// package (already a project dependency) and deep-compares the resulting objects, not the raw text, so
// comment-only or whitespace-only edits in either file never false-fail the check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { LOOPOVER_REPO_FOCUS_MANIFEST_YAML } from "../src/config/loopover-repo-focus-manifest.js";

const ROOT_MANIFEST_PATH = ".loopover.yml";

function defaultReadFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

/** Recursively sort object keys so deep-equal comparisons never depend on key insertion order (YAML key
 *  order is not semantically meaningful; a reordered-but-equivalent block must not be reported as drift). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Deep-compares the real root .loopover.yml against the bundled fallback YAML constant. `readFile(root,
 * relativePath)` and `bundledYaml` are both injectable so tests can simulate a diverged pair without
 * touching the real filesystem or the real bundled constant. Returns `{ failures, rootManifest,
 * bundledManifest }` -- pure given its inputs, no process.exit/console side effects of its own (those live
 * in main()).
 */
export function checkManifestDrift(options: {
  root: string;
  readFile?: (root: string, relativePath: string) => string;
  bundledYaml?: string;
}): {
  failures: string[];
  rootManifest: unknown;
  bundledManifest: unknown;
} {
  const { root, readFile = defaultReadFile, bundledYaml = LOOPOVER_REPO_FOCUS_MANIFEST_YAML } = options;
  const failures: string[] = [];

  const rootManifestText = readFile(root, ROOT_MANIFEST_PATH);
  const rootManifest = parseYaml(rootManifestText);
  const bundledManifest = parseYaml(bundledYaml);

  const sortedRoot = sortKeysDeep(rootManifest);
  const sortedBundled = sortKeysDeep(bundledManifest);
  const rootJson = JSON.stringify(sortedRoot, null, 2);
  const bundledJson = JSON.stringify(sortedBundled, null, 2);

  if (rootJson !== bundledJson) {
    failures.push(
      [
        `${ROOT_MANIFEST_PATH} and LOOPOVER_REPO_FOCUS_MANIFEST_YAML (src/config/loopover-repo-focus-manifest.ts) have drifted apart.`,
        `-- ${ROOT_MANIFEST_PATH} (parsed) --`,
        rootJson,
        `-- LOOPOVER_REPO_FOCUS_MANIFEST_YAML (parsed) --`,
        bundledJson,
      ].join("\n"),
    );
  }

  return { failures, rootManifest, bundledManifest };
}

function main() {
  const { failures } = checkManifestDrift({ root: process.cwd() });

  if (failures.length > 0) {
    console.error(`Manifest-drift check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  console.log(`Manifest-drift check ok: ${ROOT_MANIFEST_PATH} and LOOPOVER_REPO_FOCUS_MANIFEST_YAML agree.`);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
