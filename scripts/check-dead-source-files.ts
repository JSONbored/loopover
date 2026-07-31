#!/usr/bin/env node
// Guards against a silently dead feature file (#9492): a `src/**` module with zero non-test importers is
// either a forgotten wire-up (issue-rag-wire.ts, deleted in the same PR that added this check — both real
// consumers imported packages/loopover-engine/src/issue-rag-query directly, and only its own test imported
// the wire) or straightforwardly stale. Coverage does not catch this class: the dead module's OWN test
// exercises it directly, so it reports green while contributing nothing to the running system. Commit
// 39cc9583c shows this exact class has bitten before.
//
// There are ~26 `*-wire.ts` files and no registration protocol (feature-activation.ts's total `Record` over
// CONVERGED_FEATURE_KEYS is the one drift-proof exception, by construction) — this check is the closest
// mechanical substitute: "does anything besides this file's own test import it at all".
//
// DELIBERATELY NARROW. This is not a general dead-code/knip-style analysis (no re-export chasing, no
// detection of a file that's imported but whose EXPORTS are all unused) — it only answers "is this file
// imported by anything outside its own test", which is exactly the shape of failure #9492 found and cheap
// enough to run on every PR. A real entry point (the worker's own `src/index.ts`, ambient `.d.ts` files,
// migrations, scripts) is never import-reached by design, so those roots are excluded rather than allowlisted
// file-by-file — an allowlist of individual dead files would defeat the check's own purpose.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = "src";
const TEST_ROOT = "test";
/** Roots whose files are legitimate PRODUCTION importers of `src/**`, scanned for imports but never
 *  themselves checked for deadness. `scripts/**` earns this: several CLIs and drift-checkers are the sole
 *  consumer of a `src/**` module (check-migrations.ts -> src/db/migration-column-extraction.ts,
 *  draft-issue.ts -> src/services/issue-drafting.ts), and those modules are emphatically alive. */
const IMPORTER_ROOTS = ["scripts"] as const;
// .d.ts: ambient/generated declaration files are never import-reached by a relative specifier — they're
// picked up by tsconfig's `include`/global ambient resolution instead.
const SOURCE_PATTERN = /(?<!\.d)\.ts$/;
const EXCLUDED_SEGMENT = /(?:^|\/)(?:node_modules|dist|dist-test)(?:\/|$)/;

// Real entry points: never reached by a relative import from elsewhere in the tree by construction, so
// scanning for their importers would always report a false dead-file positive. Each is a directory-relative
// glob-free literal path or a path prefix; extend with a one-line reason, same convention as
// check-import-specifiers.ts's ALLOWED_FILENAMES.
const ENTRY_POINT_FILES = new Set([
  "src/index.ts", // the Worker's fetch/queue/scheduled export — Wrangler's `main`, never relatively imported.
  "src/env.d.ts", // ambient global Env augmentation.
  "src/server.ts", // the self-host Node entry point — invoked by the Dockerfile, never relatively imported.
  // Both below are esbuild ALIAS TARGETS resolved by path string in scripts/build-selfhost.ts's onResolve
  // hooks (`cloudflare:workers` and `agents/mcp` -> these files), so no relative import can ever name them.
  "src/selfhost/cf-workers-shim.ts",
  "src/selfhost/stubs/agents-mcp.ts",
]);
// Path PREFIXES (not just filenames) that are structurally entry-point-shaped and would otherwise need one
// ENTRY_POINT_FILES line per file: each is invoked by its OWN runner (a CLI, a route table scanned by path,
// a migration runner reading the directory), never relatively imported by sibling source.
const ENTRY_POINT_PREFIXES = ["src/mcp/tools/", "src/mcp/cli/"];

/**
 * Files that are legitimately unconsumed RIGHT NOW because they were landed deliberately ahead of their
 * consumers — a staged seam, not rot. Each entry must name the tracking issue that migrates callers onto it,
 * which is the whole difference between this and a silent allowlist: an unexplained dead file is exactly what
 * this check exists to catch, so an exception has to state why and say where it ends.
 *
 * Remove the entry once the seam gains its first real consumer — from that point the check protects it for free.
 */
const STAGED_AHEAD_OF_CONSUMERS: ReadonlyMap<string, string> = new Map([
  [
    "src/openapi/define-route.ts",
    "The route-registration seam (#9519), landed by #9533 ahead of the 241-route migration it exists for; #9531 moves routes onto it incrementally.",
  ],
  [
    "src/chat/grounding-registry.ts",
    "The maintainer chat grounding-tool registry (#9189, spec #9187). Deliberately ahead of its route: the six tools are defined over an INJECTED GroundingServices surface, and binding that surface to the real readers (queueSnapshotFromBinding, verifyDecisionLedger, resolveProofPage, loadRepoFocusManifest, getRepository) plus wiring the protected route and its authz is the second half of #9189. The registry's own invariants -- read-only by construction, allowlisted response shapes, determinism, per-tool budgets -- are fully covered by test/unit/grounding-registry.test.ts today.",
  ],
  [
    "src/review/benchmark-eval-records.ts",
    "The benchmark score-record emitter + leaderboard derivation (#9265). Deliberately ahead of its serving route: #9216's endpoint sub-issue wires GET /v1/public/eval-scores to emit benchmark_run records, and #9264 supplies the attestation envelopes its `attested` tier needs. Fully covered by test/unit/benchmark-eval-records.test.ts today.",
  ],
]);

function isEntryPoint(file: string): boolean {
  return ENTRY_POINT_FILES.has(file) || ENTRY_POINT_PREFIXES.some((prefix) => file.startsWith(prefix));
}

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

export type DeadSourceFileViolation = { file: string; reason: string };

/**
 * Pure over its inputs: resolves every `src/**` module's relative-import specifiers found across BOTH
 * `src/**` and `test/**`, and reports a source file with zero importers outside its own test file.
 *
 * Resolution is specifier-text matching, not a real module resolver — it strips a trailing `.js`/`.ts`
 * extension (see check-import-specifiers.ts's own doc for why both appear across the tree's two resolution
 * zones) and normalizes `./`/`../` against the IMPORTING file's directory, then checks whether the result
 * names a real `.ts` file (trying both the bare path and its `/index.ts` form). This is sufficient for every
 * import in this codebase — none of which use path-mapped aliases or bundler-magic specifiers — without
 * needing a full TypeScript program.
 *
 * `list*`/`readFile` are injectable so tests can simulate a fresh dead file without writing into the real
 * tree.
 */
export function findDeadSourceFiles(
  options: {
    sourceRoot?: string;
    testRoot?: string;
    importerRoots?: readonly string[];
    stagedAheadOfConsumers?: ReadonlyMap<string, string>;
    listSourceFiles?: (root: string, pattern: RegExp) => string[];
    listTestFiles?: (root: string, pattern: RegExp) => string[];
    readFile?: (file: string) => string;
    fileExists?: (file: string) => boolean;
  } = {},
): DeadSourceFileViolation[] {
  const {
    sourceRoot = SOURCE_ROOT,
    testRoot = TEST_ROOT,
    importerRoots = IMPORTER_ROOTS,
    stagedAheadOfConsumers = STAGED_AHEAD_OF_CONSUMERS,
    listSourceFiles = defaultListFiles,
    listTestFiles = defaultListFiles,
    readFile = (file: string) => readFileSync(file, "utf8"),
    fileExists = (file: string) => {
      try {
        readFileSync(file, "utf8");
        return true;
      } catch {
        return false;
      }
    },
  } = options;

  const sourceFiles = listSourceFiles(sourceRoot, SOURCE_PATTERN);
  const testFiles = listTestFiles(testRoot, /\.ts$/);
  const importerFiles = importerRoots.flatMap((root) => listSourceFiles(root, /\.ts$/));
  const sourceFileSet = new Set(sourceFiles);

  // #9492: the one real per-file test pairing convention this repo has (test/unit/<name>.test.ts mirroring
  // src/**/<name>.ts) — used to exclude a file's OWN test from counting as its sole importer. Matched by
  // basename, not by directory mirroring (the tree doesn't mirror src/'s subdirectories under test/unit/),
  // which is deliberately loose: it only needs to identify "this could plausibly be file X's own test", not
  // prove it, since the real signal is "is anything ELSE importing it".
  const basenameOf = (file: string): string => (file.split("/").pop() ?? file).replace(/\.ts$/, "");
  const ownTestOf = (sourceFile: string): string => `${basenameOf(sourceFile)}.test.ts`;

  function resolveSpecifier(fromFile: string, specifier: string): string | null {
    const fromDir = fromFile.split("/").slice(0, -1).join("/");
    const parts = `${fromDir}/${specifier}`.split("/");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "." || part === "") continue;
      if (part === "..") resolved.pop();
      else resolved.push(part);
    }
    const base = resolved.join("/");
    const bare = `${base}.ts`;
    if (sourceFileSet.has(bare)) return bare;
    const indexed = `${base}/index.ts`;
    if (sourceFileSet.has(indexed)) return indexed;
    // A specifier resolving OUTSIDE src/** (e.g. into packages/**) is legitimate and simply not tracked by
    // this checker — it only answers reachability WITHIN src/**.
    if (fileExists(bare)) return null;
    if (fileExists(indexed)) return null;
    return null;
  }

  const importedBy = new Map<string, Set<string>>(); // resolved source file -> set of importer files
  const specifierPattern = /(?:from|import)\s*\(?\s*"((?:\.{1,2}\/)[^"]+?)(?:\.js|\.ts)?"/g;
  for (const importerFile of [...sourceFiles, ...testFiles, ...importerFiles]) {
    for (const match of readFile(importerFile).matchAll(specifierPattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolved = resolveSpecifier(importerFile, specifier);
      if (!resolved) continue;
      const importers = importedBy.get(resolved) ?? new Set<string>();
      importers.add(importerFile);
      importedBy.set(resolved, importers);
    }
  }

  const violations: DeadSourceFileViolation[] = [];
  for (const file of sourceFiles) {
    if (isEntryPoint(file)) continue;
    if (stagedAheadOfConsumers.has(file)) continue;
    const importers = importedBy.get(file) ?? new Set<string>();
    const ownTest = ownTestOf(file);
    const nonTestImporters = [...importers].filter((importer) => {
      const isTestFile = importer.startsWith(`${testRoot}/`);
      const isOwnTest = isTestFile && (importer.split("/").pop() ?? importer) === ownTest;
      return !isOwnTest;
    });
    if (nonTestImporters.length === 0) {
      violations.push({
        file,
        reason: importers.size === 0 ? "no importer at all (including its own test)" : "only its own test imports it — no production consumer",
      });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

function main(): void {
  const violations = findDeadSourceFiles();
  if (violations.length === 0) {
    process.stdout.write("dead source files: OK\n");
    return;
  }
  process.stderr.write(`Found ${violations.length} src/** file(s) with no production importer (#9492):\n`);
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file} — ${violation.reason}\n`);
  }
  process.stderr.write(
    "\nEither wire the file up, delete it, or — if it's a genuine new entry point invoked outside a relative\n" +
      "import (a new CLI, a route table, a migration runner) — add it to ENTRY_POINT_FILES/ENTRY_POINT_PREFIXES\n" +
      "in scripts/check-dead-source-files.ts with a one-line reason. If it is a seam landed deliberately AHEAD\n" +
      "of the callers it exists for, add it to STAGED_AHEAD_OF_CONSUMERS naming the issue that migrates them.\n",
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
