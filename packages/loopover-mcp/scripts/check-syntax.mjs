#!/usr/bin/env node
// Syntax-verifies every compiled/hand-written .js file in bin/ and lib/, plus every .mjs script, via
// `node --check`. Replaces a previously hand-listed chain of individual `node --check <file>` commands
// in package.json's own "build" script -- that list had to be kept in sync by hand every time a file was
// added, removed, or migrated to TypeScript (#7290's mcp counterpart, #7291). Glob-driven instead: covers
// every file automatically, migrated or not, with no list to fall out of date.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// fileURLToPath (not URL.pathname): on Windows, pathname is "/D:/..." and join() can produce a doubled
// drive prefix (D:\D:\...), which breaks readdirSync. Same pattern as packages/loopover-miner/bin.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function listFiles(dir, extension) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(dir, entry.name));
}

const files = [...listFiles("dist/bin", ".js"), ...listFiles("dist/lib", ".js"), ...listFiles("scripts", ".mjs")].sort();

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    failures.push({ file, message: error.stderr?.toString().trim() || String(error) });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`${file}:\n${message}\n`);
  }
  console.error(`node --check failed for ${failures.length} of ${files.length} file(s).`);
  process.exit(1);
}

console.log(`node --check passed for all ${files.length} files in dist/bin/, dist/lib/, and scripts/.`);
