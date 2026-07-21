#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_CONTENT } from "./forbidden-content.js";
import { MCP_PACKAGE_ALLOWED_FILE_PATTERNS } from "./mcp-package-allowlist.js";

const FORBIDDEN_PATH = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const STALE_PACKAGE_TEXT = /(private beta|zeronode\.workers\.dev|preview URL)/i;

export function validateMcpPackFileList(files, readContent) {
  const paths = files.map((file) => (typeof file === "string" ? file : file.path)).sort();
  for (const file of paths) {
    if (FORBIDDEN_PATH.test(file)) throw new Error(`Forbidden file in MCP package: ${file}`);
    if (!MCP_PACKAGE_ALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(file)))
      throw new Error(`Unexpected file in MCP package: ${file}`);
    const content = readContent(file);
    if (FORBIDDEN_CONTENT.test(content)) throw new Error(`Secret-like content found in MCP package file: ${file}`);
    if (file === "README.md" && STALE_PACKAGE_TEXT.test(content))
      throw new Error(`Stale public-package wording found in MCP package file: ${file}`);
  }
  return paths;
}

export function runMcpPackCheck(options = {}) {
  const pack = options.pack ?? loadMcpPackFromNpm();
  const packageRoot = options.packageRoot ?? join(process.cwd(), "packages/loopover-mcp");
  const readContent =
    options.readContent ??
    ((file) => {
      if (process.env.CHECK_MCP_PACK_TEST_CONTENT !== undefined) return process.env.CHECK_MCP_PACK_TEST_CONTENT;
      return readFileSync(join(packageRoot, file), "utf8");
    });
  const paths = validateMcpPackFileList(pack.files, readContent);
  return `MCP package dry-run ok: ${paths.join(", ")}\n`;
}

function loadMcpPackFromNpm() {
  if (process.env.CHECK_MCP_PACK_TEST_FILES) {
    const paths = JSON.parse(process.env.CHECK_MCP_PACK_TEST_FILES);
    return { files: paths.map((path) => ({ path })) };
  }
  const result = spawnSync("npm", ["pack", "--workspace", "@loopover/mcp", "--dry-run", "--json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || "npm pack failed";
    throw new Error(message.trim());
  }
  return JSON.parse(result.stdout)[0];
}

function main() {
  try {
    process.stdout.write(runMcpPackCheck());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
