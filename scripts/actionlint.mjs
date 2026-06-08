import { spawnSync } from "node:child_process";
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
const maxAttempts = Number.parseInt(process.env.ACTIONLINT_ATTEMPTS ?? "3", 10);
const retryDelayMs = Number.parseInt(process.env.ACTIONLINT_RETRY_DELAY_MS ?? "1000", 10);

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(bin, files, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status === 0) {
    process.exit(0);
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const downloadFailed = output.includes("github-actionlint: Download failed:");
  if (!downloadFailed || attempt === maxAttempts) {
    process.exit(result.status ?? 1);
  }

  console.error(`actionlint download failed; retrying (${attempt + 1}/${maxAttempts})...`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelayMs);
}
