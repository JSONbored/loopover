#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function main() {
  const requestedChecks = new Set(process.argv.slice(2));
  const validArgs = new Set(["--root", "--mcp"]);
  const invalidArgs = [...requestedChecks].filter((arg) => !validArgs.has(arg));

  if (invalidArgs.length > 0) {
    console.error(`Unknown changelog check option: ${invalidArgs.join(", ")}`);
    process.exit(1);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "loopover-changelog-"));

  try {
    const checks = [
      {
        label: "root changelog",
        output: "CHANGELOG.md",
        command: "npm run changelog:root",
        selector: "--root",
        runner: () => {
          const generatedPath = join(tempDir, "CHANGELOG.md");
          run(["git-cliff", "--config", "cliff.toml", "--output", generatedPath], "root changelog");
          return generatedPath;
        },
      },
      {
        label: "MCP package changelog",
        output: "packages/loopover-mcp/CHANGELOG.md",
        command: "npm run changelog:mcp",
        selector: "--mcp",
        runner: () => {
          const generatedPath = join(tempDir, "MCP_CHANGELOG.md");
          const version = JSON.parse(readFileSync("packages/loopover-mcp/package.json", "utf8")).version;
          writeFileSync(generatedPath, readFileSync("packages/loopover-mcp/CHANGELOG.md", "utf8"));
          run(["node", "scripts/generate-mcp-changelog.mjs", "--output", generatedPath, "--version", version], "MCP package changelog");
          return generatedPath;
        },
      },
    ].filter((check) => requestedChecks.size === 0 || requestedChecks.has(check.selector));

    const failures = [];
    for (const check of checks) {
      const generatedPath = check.runner();
      const expected = readFileSync(generatedPath, "utf8");
      const actual = readFileSync(check.output, "utf8");
      if (normalize(actual) !== normalize(expected)) failures.push(`${check.output} is stale; run ${check.command}.`);
    }

    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exit(1);
    }

    console.log(`${checks.map((check) => check.output).join(", ")} current`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** Run a command, failing the process with its real output on a non-zero status. `spawn` and `onFailure` are
 *  injectable purely for testability; every real caller uses the defaults. When the command cannot even
 *  launch (`status` is null, e.g. the binary is not on PATH), `result.error` holds the actual ENOENT/EACCES
 *  reason -- surface its message (#7772) instead of the generic `${label} failed`, which wastes debugging time. */
export function run(command, label, { spawn = spawnSync, onFailure = defaultOnFailure } = {}) {
  const result = spawn(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || (result.error ? `${label}: ${result.error.message}\n` : `${label} failed`);
    onFailure(message, result.status ?? 1);
  }
}

function defaultOnFailure(message, code) {
  process.stderr.write(message);
  process.exit(code);
}

function normalize(value) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

/* v8 ignore next -- entrypoint guard: runs the checks only as a CLI, so importing `run` for tests is a no-op. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
