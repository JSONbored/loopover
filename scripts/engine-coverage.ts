// Harvest @loopover/engine's real node:test coverage into an lcov Codecov can ingest (#9064).
// The engine package's own suite (packages/loopover-engine/test/**/*.test.ts, compiled to
// dist-test/**/*.test.js by `npm run test --workspace @loopover/engine`) runs under plain
// `node --test`, with no instrumentation and no Codecov upload -- so engine source is graded only
// by whatever vitest's root test/** suite happens to import, even though vitest.config.ts's
// coverage.include already counts packages/loopover-engine/src/** toward the total. That mismatch
// rewards duplicating a thin vitest test alongside the real ungraded node:test one instead of
// deepening the real suite.
//
// Runs c8 from the monorepo root so source-map remapping (packages/loopover-engine/tsconfig.json's
// "sourceMap": true) yields `packages/loopover-engine/src/**` paths, not bare `dist/**` -- mirroring
// rees-coverage.ts / control-plane-coverage.mjs's identical "node:test suite invisible to vitest"
// shape and their `--include=<pkg>/dist/**/*.js` + `--all` + lcov-path-normalize recipe.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

/** Normalize c8's SF: paths to forward slashes for Codecov. Swallows only a missing report
 *  (ENOENT on read) -- CI's "Verify engine coverage report exists" step fails closed downstream.
 *  Any other read/write error propagates so a real lcov post-process failure is not masked. */
export function normalizeLcovSfPaths(
  lcovPath: string,
  { readFile = readFileSync, writeFile = writeFileSync }: { readFile?: (path: string, encoding: "utf8") => string; writeFile?: (path: string, data: string) => void } = {},
): void {
  try {
    const raw = readFile(lcovPath, "utf8");
    writeFile(
      lcovPath,
      raw.replace(/^SF:(.*)$/gm, (_match, path) => `SF:${String(path).replace(/\\/g, "/")}`),
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function collectTests(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) collectTests(path, out);
    else if (ent.name.endsWith(".test.js")) out.push(path);
  }
  return out;
}

function main() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const c8Bin = join(root, "node_modules", "c8", "bin", "c8.js");
  const pkgDir = join(root, "packages", "loopover-engine");
  const reportDir = join(pkgDir, "coverage");
  const testRoot = join(pkgDir, "dist-test");

  // Relative to root: c8's --include glob below is matched against cwd-relative paths, and Codecov
  // wants repo-relative SF: paths anyway, so express everything the same way from the start.
  const tests = collectTests(testRoot).map((path) => relative(root, path).split("\\").join("/"));
  if (tests.length === 0) {
    console.error("engine-coverage: no packages/loopover-engine/dist-test/**/*.test.js files found -- run `npm run test --workspace @loopover/engine` first");
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    [
      c8Bin,
      "--reporter=lcov",
      "--reporter=text-summary",
      `--report-dir=${reportDir}`,
      "--include=packages/loopover-engine/dist/**/*.js",
      "--exclude=**/*.d.ts",
      "--all",
      process.execPath,
      "--test",
      ...tests,
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );

  // Codecov expects forward-slash SF: paths; c8 on Windows emits backslashes.
  normalizeLcovSfPaths(join(reportDir, "lcov.info"));

  process.exit(result.status === null ? 1 : result.status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
