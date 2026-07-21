#!/usr/bin/env node
// Guards against the "gittensory" branding silently creeping back into runtime source after the LoopOver
// rebrand -- distinct from docs/prose residue (already owned by the ongoing rebrand-sweep PR series), this
// targets the class of bug that actually broke things: a hardcoded metric name, MCP resource URI, or Qdrant
// collection default left on the pre-rebrand string. That exact pattern caused live drift more than once
// (e.g. #6786 -- ENRICHMENT_ANALYZERS_URI silently left as "gittensory://enrichment-analyzers" while its
// sibling FINDING_TAXONOMY_URI was correctly renamed in the same PR). Scoped to executable code in `src/**`
// and each workspace package's `bin/`, `lib/`, `src/`, `scripts/` dirs -- NOT `test/**` or `*.md`, where a
// literal "gittensory" is usually an intentional, permanent historical reference (a Sentry ticket ID like
// GITTENSORY-K/8, a stable comment-marker the bot must keep matching in already-posted PR bodies, a DB
// `source` column value joined against historical rows) rather than drift; those files churn constantly and
// would make this check pure noise if included.
//
// Baseline-diff, not a hard "zero gittensory" ban: scripts/branding-drift-baseline.json snapshots today's
// known-legitimate per-file hit count (grandfathered, same shape as KNOWN_MIGRATION_DUPLICATES in
// src/db/migration-collisions.ts). A file's count rising means new drift; falling means a cleanup landed
// without updating the baseline. Either way the fix is the same: run `npm run branding-drift:update` and
// commit the regenerated baseline -- mirrors this repo's existing generated-artifact convention (openapi.json,
// cf-typegen, migrations) rather than inventing a new one.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASELINE_RELATIVE_PATH = "scripts/branding-drift-baseline.json";

// git pathspecs: executable code only. Each workspace package's bin/lib/src/scripts dirs mirror the
// top-level src/** scope; docs/README/CHANGELOG/schema/terraform/css and every test dir are deliberately
// excluded (see header comment).
export const BRANDING_DRIFT_PATHSPECS = [
  "src/**/*.ts",
  "src/**/*.tsx",
  "packages/*/bin/**",
  "packages/*/lib/**/*.js",
  "packages/*/lib/**/*.ts",
  "packages/*/src/**/*.ts",
  "packages/*/scripts/**/*.mjs",
  "apps/*/src/**/*.ts",
  "apps/*/src/**/*.tsx",
  "apps/*/scripts/**/*.mjs",
  ":(exclude)**/*.test.ts",
  ":(exclude)**/*.test.tsx",
  ":(exclude)packages/*/test/**",
];

function defaultExec(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    // git grep exits 1 for "zero matches" -- not a real failure, just an empty result.
    if ((error as NodeJS.ErrnoException & { status?: number }).status === 1) return "";
    throw error;
  }
}

/** Every tracked, non-excluded file with >=1 case-insensitive "gittensory" MATCHING LINE, and that line
 *  count (line-granularity, not raw occurrence count -- sufficient to detect "something new appeared" without
 *  the fragility of an exact substring-occurrence count). Uses `git grep`, so it only ever sees tracked files
 *  exactly as CI would check them out -- no node_modules/dist/build noise to exclude by hand. */
export function scanBrandingHits({ root, exec = defaultExec }: { root: string; exec?: typeof defaultExec }): Record<string, number> {
  const output = exec(root, ["grep", "-ciI", "gittensory", "--", ...BRANDING_DRIFT_PATHSPECS]);
  const counts: Record<string, number> = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const separatorIndex = line.lastIndexOf(":");
    const file = line.slice(0, separatorIndex);
    counts[file] = Number(line.slice(separatorIndex + 1));
  }
  return counts;
}

/** Pure comparison: every failure is one of "increased" (new drift -- or a file that didn't exist in the
 *  baseline at all, same failure shape) or "decreased" (a cleanup landed; still a failure so the baseline
 *  never silently drifts stale, but a one-line fix -- regenerate). Sorted for stable, reviewable CI output. */
export function diffBrandingBaseline(baseline: Record<string, number>, current: Record<string, number>): string[] {
  const failures: string[] = [];
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const before = baseline[file] ?? 0;
    const after = current[file] ?? 0;
    if (after > before) {
      failures.push(
        `${file}: "gittensory" mentions increased from ${before} to ${after} -- looks like new branding drift, not an intentional historical reference. If it genuinely belongs (e.g. a permanent Sentry ticket ID or a stable comment-marker already posted to live PRs), run \`npm run branding-drift:update\` and commit the regenerated baseline.`,
      );
    } else if (after < before) {
      failures.push(
        `${file}: "gittensory" mentions decreased from ${before} to ${after} -- looks like a cleanup landed without regenerating the baseline. Run \`npm run branding-drift:update\` and commit the result.`,
      );
    }
  }
  return failures;
}

function readBaseline(root: string): Record<string, number> {
  return JSON.parse(readFileSync(join(root, BASELINE_RELATIVE_PATH), "utf8"));
}

function writeBaseline(root: string, counts: Record<string, number>): void {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(root, BASELINE_RELATIVE_PATH), `${JSON.stringify(sorted, null, 2)}\n`);
}

function main() {
  const root = process.cwd();
  const update = process.argv.includes("--update");
  const current = scanBrandingHits({ root });

  if (update) {
    writeBaseline(root, current);
    console.log(`Branding-drift baseline regenerated: ${Object.keys(current).length} file(s) with a "gittensory" reference.`);
    return;
  }

  const baseline = readBaseline(root);
  const failures = diffBrandingBaseline(baseline, current);

  if (failures.length > 0) {
    console.error(`Branding-drift check found ${failures.length} issue(s):`);
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }

  console.log(`Branding-drift check ok: ${Object.keys(current).length} file(s) match the recorded baseline.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
