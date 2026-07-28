#!/usr/bin/env node
// Syntax-verifies every compiled/hand-written .js file in bin/ and lib/ via `node --check`. Replaces a
// previously hand-listed chain of ~119 individual `node --check <file>` commands in package.json's own
// "build" script -- that list had to be kept in sync by hand every time a file was added, removed, or
// migrated to TypeScript (#7290), the same maintenance burden as vitest.config.ts's coverage-include
// globs it sat next to. Glob-driven instead: covers every .js file in bin/lib automatically, migrated or
// not, with no list to fall out of date.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;

function listFiles(dir: string, extension: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(dir, entry.name));
}

// scripts/*.ts is included so this package's own build scripts stay syntax-verified after the #9527
// port -- `node --check` accepts .ts under --experimental-strip-types. Without it, porting a script
// out of .mjs would silently remove it from every check in the repo.
const files = [...listFiles("dist/bin", ".js"), ...listFiles("dist/lib", ".js"), ...listFiles("scripts", ".ts")].sort();

const failures: Array<{ file: string; message: string }> = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--experimental-strip-types", "--check", file], { cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    failures.push({ file, message: stderr?.toString().trim() || String(error) });
  }
}

if (failures.length > 0) {
  for (const { file, message } of failures) {
    console.error(`${file}:\n${message}\n`);
  }
  console.error(`node --check failed for ${failures.length} of ${files.length} file(s).`);
  process.exit(1);
}

console.log(`node --check passed for all ${files.length} files in dist/bin/ and dist/lib/.`);
