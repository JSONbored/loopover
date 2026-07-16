#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MCP_PACKAGE_ALLOWED_FILE_PATTERNS } from "./mcp-package-allowlist.mjs";

const result = spawnSync("npm", ["pack", "--workspace", "@loopover/mcp", "--dry-run", "--json"], {
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((file) => file.path).sort();
const allowed = MCP_PACKAGE_ALLOWED_FILE_PATTERNS;
const forbiddenPath = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const forbiddenContent = /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;
const stalePackageText = /(private beta|zeronode\.workers\.dev|preview URL)/i;

for (const file of files) {
  if (forbiddenPath.test(file)) throw new Error(`Forbidden file in MCP package: ${file}`);
  if (!allowed.some((pattern) => pattern.test(file))) throw new Error(`Unexpected file in MCP package: ${file}`);
  const fullPath = join("packages/loopover-mcp", file);
  const content = readFileSync(fullPath, "utf8");
  if (forbiddenContent.test(content)) throw new Error(`Secret-like content found in MCP package file: ${file}`);
  if (file === "README.md" && stalePackageText.test(content)) throw new Error(`Stale public-package wording found in MCP package file: ${file}`);
}

process.stdout.write(`MCP package dry-run ok: ${files.join(", ")}\n`);
