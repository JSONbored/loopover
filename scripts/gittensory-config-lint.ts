#!/usr/bin/env tsx
// Wires up the previously-unwired src/selfhost/config-lint.ts validator (#2906): a self-hoster (or the
// maintainer, dogfooding on JSONbored/gittensory) can now actually run it against a real .gittensory.yml or
// private-config file and get actionable feedback, instead of the validator existing only in its own test suite.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { lintManifestText, type SelfHostConfigLintResult } from "../src/selfhost/config-lint";

function usage(): string {
  return `Usage: npm run selfhost:config-lint -- [path]

Validates a Gittensory focus manifest (.gittensory.yml, a per-repo/global self-host
private-config file, or any equivalent YAML/JSON file with the same shape) and reports
unrecognized top-level fields and parser warnings, without echoing any of the file's values.

Options:
  path   Manifest file to lint. Defaults to ".gittensory.yml" in the current directory.`;
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
  if (!existsSync(path)) {
    console.error(`gittensory-config-lint: no such file: ${path}\n\n${usage()}`);
    process.exit(1);
  }
  const text = readFileSync(path, "utf8");
  const result = lintManifestText(text);
  console.log(formatLintReport(path, result));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
/* v8 ignore stop */
