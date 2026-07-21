// Harvest review-enrichment's real node:test coverage into an lcov Codecov can ingest (#6250).
// Runs c8 from the monorepo root so source-map remapping yields `review-enrichment/src/**` paths
// (not bare `src/**`), and expands the test list in-process so Windows/npm quoting cannot drop the suite.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

/** Normalize c8's SF: paths to forward slashes for Codecov. Swallows only a missing report
 *  (ENOENT on read) — CI's "Verify REES coverage report exists" step fails closed downstream.
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
    else if (ent.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function main() {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const c8Bin = join(root, "review-enrichment", "node_modules", "c8", "bin", "c8.js");
  const reportDir = join(root, "review-enrichment", "coverage");
  const testRoot = join(root, "review-enrichment", "test");

  const tests = collectTests(testRoot).map((path) => relative(root, path).split("\\").join("/"));
  if (tests.length === 0) {
    console.error("rees-coverage: no review-enrichment/test/**/*.test.ts files found");
    process.exit(1);
  }

  const result = spawnSync(
    process.execPath,
    [
      c8Bin,
      "--reporter=lcov",
      "--reporter=text-summary",
      `--report-dir=${reportDir}`,
      "--include=review-enrichment/dist/**/*.js",
      "--exclude=**/*.d.ts",
      "--all",
      process.execPath,
      "--test",
      "--experimental-strip-types",
      ...tests,
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );

  // Codecov expects forward-slash SF: paths; c8 on Windows emits backslashes.
  normalizeLcovSfPaths(join(reportDir, "lcov.info"));

  process.exit(result.status === null ? 1 : result.status);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
