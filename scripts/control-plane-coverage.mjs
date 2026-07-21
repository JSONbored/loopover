// Harvest control-plane's real node:test coverage into an lcov Codecov can ingest (#7743).
// Runs c8 from the monorepo root so source-map remapping yields `control-plane/src/**` paths
// (not bare `src/**`), and expands the test list in-process so Windows/npm quoting cannot drop the suite.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const c8Bin = join(root, "control-plane", "node_modules", "c8", "bin", "c8.js");
const reportDir = join(root, "control-plane", "coverage");
const testRoot = join(root, "control-plane", "test");

function collectTests(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) collectTests(path, out);
    else if (ent.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const tests = collectTests(testRoot).map((path) => relative(root, path).split("\\").join("/"));
if (tests.length === 0) {
  console.error("control-plane-coverage: no control-plane/test/**/*.test.ts files found");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    c8Bin,
    "--reporter=lcov",
    "--reporter=text-summary",
    `--report-dir=${reportDir}`,
    "--include=control-plane/dist/**/*.js",
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
const lcovPath = join(reportDir, "lcov.info");
try {
  const raw = readFileSync(lcovPath, "utf8");
  writeFileSync(
    lcovPath,
    raw.replace(/^SF:(.*)$/gm, (_match, path) => `SF:${String(path).replace(/\\/g, "/")}`),
  );
} catch {
  // CI's "Verify control-plane coverage report exists" step fails closed if the report is missing.
}

process.exit(result.status === null ? 1 : result.status);
