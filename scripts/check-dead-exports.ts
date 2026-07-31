#!/usr/bin/env node
// Guards against a silently dead EXPORT (#9852) — the gap check-dead-source-files.ts names in its own header:
//
//   > DELIBERATELY NARROW. This is not a general dead-code/knip-style analysis (no re-export chasing, no
//   > detection of a file that's imported but whose EXPORTS are all unused)
//
// That gap was populated: 87 `src/**` symbols were exported and referenced nowhere outside the file that
// declared them — not by another module, not by a script, not even by their own test. Each one is one of
// three things, and nothing told them apart:
//
//   1. A missing wire-up — #9492's class one level down. An export with no caller is a feature that was
//      built and never connected.
//   2. A safety net with nothing behind it — #9851 exactly: two route-spec tables exported "for the
//      meta-test that asserts every entry's declared auth matches the middleware", test never written.
//   3. Genuinely dead surface that still has to be read, typechecked and maintained.
//
// Coverage cannot catch any of them: the declaring file's own tests exercise the symbol directly and report
// green while it contributes nothing to the running system.
//
// THE FIX IS USUALLY NOT DELETION. Most flagged symbols are used inside their own file — the export keyword
// is the only untrue part. Dropping `export` makes the surface honest and is provably safe (tsc fails if the
// symbol really was reached from elsewhere). Deletion is for a symbol with no uses at all.
//
// DELIBERATELY TEXTUAL, matching its sibling: identifier occurrences, not a TypeScript program. A symbol
// reached only through a namespace import (`import * as m`) or a dynamic string would be a false positive —
// which is what ALLOWED_EXPORTS is for, and why it demands a reason rather than a bare name.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Where exports are CHECKED. Scoped to the Worker's own source; the published packages are a separate
 *  problem (their exports are consumed outside this repo, so absence of an in-repo reference proves
 *  nothing). */
const SOURCE_ROOTS = ["src"] as const;

/** Where a reference COUNTS from. Everything that could legitimately consume `src/**`. */
const REFERENCE_ROOTS = ["src", "packages", "test", "scripts", "apps/loopover-ui/src"] as const;

const SOURCE_PATTERN = /(?<!\.d)\.tsx?$/;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|dist|dist-test)(?:\/|$)/;

/** `export const|function|class|enum NAME` (plus `async function` / `abstract class` / `const enum`) at the
 *  top level. Types and interfaces stay out of scope: an unused type costs nothing at runtime and
 *  TypeScript's own `noUnusedLocals` already covers the local case. */
const EXPORTED_RUNTIME_SYMBOL = /^export (?:async )?(?:abstract )?(?:const\s+enum|const|function|class|enum) ([A-Za-z_][A-Za-z0-9_]*)/gm;

/**
 * Exports with no in-repo reference that are nonetheless legitimate, each with the reason.
 *
 * Same contract as check-dead-source-files.ts's STAGED_AHEAD_OF_CONSUMERS: an entry states WHY and, where
 * it applies, what ends it. An unexplained dead export is exactly what this check exists to catch, so an
 * exception has to say something.
 */
const ALLOWED_EXPORTS: ReadonlyMap<string, string> = new Map([
  [
    "src/db/schema.ts:impactMapQueryCache",
    "Consumed by scripts/check-schema-drift.ts, which PARSES this file's sqliteTable declarations rather than importing the symbol — the table's reads/writes are raw SQL (`FROM impact_map_query_cache`). Deleting the declaration would blind the drift check to the table.",
  ],
]);

function defaultListFiles(root: string, pattern: RegExp): string[] {
  try {
    return readdirSync(root, { recursive: true })
      .map(String)
      .filter((entry) => pattern.test(entry) && !EXCLUDED_SEGMENT.test(entry))
      .map((entry) => `${root}/${entry}`);
  } catch {
    return [];
  }
}

export type DeadExportViolation = { file: string; symbol: string; internalUses: number };

/**
 * Pure over its inputs: reports every exported runtime symbol in `sourceRoots` whose identifier appears
 * nowhere in `referenceRoots` outside its own declaring file.
 *
 * `internalUses` is carried through because it decides the fix: greater than one means the symbol is used
 * inside its file and only the `export` keyword is wrong; one means the declaration is the sole occurrence
 * and the symbol is dead outright.
 */
export function findDeadExports(
  options: {
    sourceRoots?: readonly string[];
    referenceRoots?: readonly string[];
    allowedExports?: ReadonlyMap<string, string>;
    listFiles?: (root: string, pattern: RegExp) => string[];
    readFile?: (file: string) => string;
  } = {},
): DeadExportViolation[] {
  const {
    sourceRoots = SOURCE_ROOTS,
    referenceRoots = REFERENCE_ROOTS,
    allowedExports = ALLOWED_EXPORTS,
    listFiles = defaultListFiles,
    readFile = (file: string) => readFileSync(file, "utf8"),
  } = options;

  const referenceFiles = [...new Set(referenceRoots.flatMap((root) => listFiles(root, SOURCE_PATTERN)))];
  const contents = new Map<string, string>();
  for (const file of referenceFiles) {
    try {
      contents.set(file, readFile(file));
    } catch {
      // A file that vanished between listing and reading contributes no references; skip it rather than
      // failing the whole check on a race.
    }
  }

  const violations: DeadExportViolation[] = [];
  for (const file of sourceRoots.flatMap((root) => listFiles(root, SOURCE_PATTERN))) {
    const own = contents.get(file);
    if (own === undefined) continue;
    for (const match of own.matchAll(EXPORTED_RUNTIME_SYMBOL)) {
      const symbol = match[1];
      if (symbol === undefined || allowedExports.has(`${file}:${symbol}`)) continue;
      const pattern = new RegExp(`\\b${symbol}\\b`, "g");
      let external = 0;
      let internalUses = 0;
      for (const [candidate, text] of contents) {
        const hits = text.match(pattern)?.length ?? 0;
        if (hits === 0) continue;
        if (candidate === file) internalUses = hits;
        else external += hits;
        if (external > 0) break;
      }
      if (external === 0) violations.push({ file, symbol, internalUses });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
}

function main(): void {
  const violations = findDeadExports();
  if (violations.length === 0) {
    process.stdout.write("check-dead-exports: no exported symbol is unreferenced outside its own file.\n");
    return;
  }
  process.stderr.write(`check-dead-exports found ${violations.length} exported symbol(s) with no reference outside their own file:\n`);
  for (const { file, symbol, internalUses } of violations) {
    const fix = internalUses > 1 ? "used internally — drop the `export` keyword" : "no uses at all — delete it, or wire up the consumer it was written for";
    process.stderr.write(`  ${file}: ${symbol} (${fix})\n`);
  }
  process.stderr.write("\nIf an export is legitimately unreferenced in-repo, add it to ALLOWED_EXPORTS with the reason.\n");
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
