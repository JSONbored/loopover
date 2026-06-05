import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const workflowDir = ".github/workflows";
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .map((name) => join(workflowDir, name));

if (files.length === 0) {
  console.error(`No workflow files found in ${workflowDir}`);
  process.exit(1);
}

const bin = process.platform === "win32" ? "github-actionlint.cmd" : "github-actionlint";
execFileSync(bin, files, { stdio: "inherit", shell: process.platform === "win32" });
