#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "gittensory-changelog-"));

try {
  const checks = [
    {
      label: "root changelog",
      output: "CHANGELOG.md",
      args: ["--config", "cliff.toml", "--output", join(tempDir, "CHANGELOG.md")],
    },
    {
      label: "MCP package changelog",
      output: "packages/gittensory-mcp/CHANGELOG.md",
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
  ];

  const failures = [];
  for (const check of checks) {
    const generatedPath = check.args.at(-1);
    run(["git-cliff", ...check.args], check.label);
    const expected = readFileSync(generatedPath, "utf8");
    const actual = readFileSync(check.output, "utf8");
    if (normalize(actual) !== normalize(expected)) failures.push(`${check.output} is stale; run npm run changelog.`);
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log("changelogs are current");
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
