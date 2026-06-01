#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const requestedChecks = new Set(process.argv.slice(2));
const validArgs = new Set(["--root", "--mcp"]);
const invalidArgs = [...requestedChecks].filter((arg) => !validArgs.has(arg));

if (invalidArgs.length > 0) {
  console.error(`Unknown changelog check option: ${invalidArgs.join(", ")}`);
  process.exit(1);
}

const tempDir = mkdtempSync(join(tmpdir(), "gittensory-changelog-"));

try {
  const checks = [
    {
      label: "root changelog",
      output: "CHANGELOG.md",
      command: "npm run changelog:root",
      selector: "--root",
      args: ["--config", "cliff.toml", "--output", join(tempDir, "CHANGELOG.md")],
    },
    {
      label: "MCP package changelog",
      output: "packages/gittensory-mcp/CHANGELOG.md",
      command: "npm run changelog:mcp",
      selector: "--mcp",
      releaseTag: () => `mcp-v${JSON.parse(readFileSync("packages/gittensory-mcp/package.json", "utf8")).version}`,
      args: [
        "--config",
        "cliff.mcp.toml",
        "--include-path",
        "packages/gittensory-mcp/**",
        "--include-path",
        ".github/workflows/npm-publish.yml",
        "--output",
        join(tempDir, "MCP_CHANGELOG.md"),
      ],
    },
  ].filter((check) => requestedChecks.size === 0 || requestedChecks.has(check.selector));

  const failures = [];
  for (const check of checks) {
    const args = [...check.args];
    const releaseTag = typeof check.releaseTag === "function" ? check.releaseTag() : null;
    if (releaseTag && changelogHasReleaseHeader(check.output, releaseTag)) args.push("--tag", releaseTag);
    const generatedPath = args[args.lastIndexOf("--output") + 1];
    run(["git-cliff", ...args], check.label);
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

function run(command, label) {
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `${label} failed`);
    process.exit(result.status ?? 1);
  }
}

function normalize(value) {
  return value.replace(/\r\n/g, "\n").trimEnd();
}

function changelogHasReleaseHeader(path, tag) {
  return new RegExp(`^## ${escapeRegExp(tag)} - `, "m").test(readFileSync(path, "utf8"));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
