#!/usr/bin/env tsx
// Wires up the previously-unwired src/selfhost/config-lint.ts validator (#2906): a self-hoster (or the
// maintainer, dogfooding on JSONbored/gittensory) can now actually run it against a real .gittensory.yml or
// private-config file and get actionable feedback, instead of the validator existing only in its own test suite.
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { lintManifestText, type SelfHostConfigLintResult } from "../src/selfhost/config-lint";
import { MAX_FOCUS_MANIFEST_BYTES } from "../src/signals/focus-manifest";

function usage(): string {
  return `Usage: npm run selfhost:config-lint -- [path]

Validates a Gittensory focus manifest (.gittensory.yml, a per-repo/global self-host
private-config file, or any equivalent YAML/JSON file with the same shape) and reports
unrecognized top-level fields and parser warnings, without echoing any of the file's values.

Options:
  path   Manifest file to lint. Defaults to ".gittensory.yml" in the current directory.`;
}

export function readManifestTextForLint(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(`no such file: ${path}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing to read symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
  if (stat.size > MAX_FOCUS_MANIFEST_BYTES) {
    throw new Error(`file exceeds ${MAX_FOCUS_MANIFEST_BYTES} bytes: ${path}`);
  }
  return readFileSync(path, "utf8");
}

export function formatLintReport(path: string, result: SelfHostConfigLintResult): string {
  const lines = [`${path}: ${result.summary}`];
  if (result.recognizedFields.length > 0) lines.push(`  recognized fields: ${result.recognizedFields.join(", ")}`);
  for (const warning of result.warnings) lines.push(`  - ${warning}`);
  return lines.join("\n");
}

/* v8 ignore start -- CLI entrypoint (file I/O + process.exit); formatLintReport above carries the tested logic. */
function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return;
  }
  const path = args[0] ?? ".gittensory.yml";
  let text;
  try {
    text = readManifestTextForLint(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gittensory-config-lint: ${message}\n\n${usage()}`);
    process.exit(1);
  }
  const result = lintManifestText(text);
  console.log(formatLintReport(path, result));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
/* v8 ignore stop */
