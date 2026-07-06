#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED = [
  /^bin\/gittensory-miner\.js$/,
  /^lib\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(js|d\.ts)$/,
  /^package\.json$/,
  /^README\.md$/,
];
const REQUIRED = ["bin/gittensory-miner.js", "package.json"];
const FORBIDDEN_PATH = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const FORBIDDEN_CONTENT =
  /(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|gts_[0-9a-f]{64}|[A-Z0-9_]*(TOKEN|SECRET|PRIVATE_KEY)=)/;

export function validateMinerPackFileList(files, readContent) {
  const paths = files.map((file) => (typeof file === "string" ? file : file.path)).sort();
  for (const file of paths) {
    if (FORBIDDEN_PATH.test(file)) throw new Error(`Forbidden file in miner package: ${file}`);
    if (!ALLOWED.some((pattern) => pattern.test(file))) throw new Error(`Unexpected file in miner package: ${file}`);
    const content = readContent(file);
    if (FORBIDDEN_CONTENT.test(content)) throw new Error(`Secret-like content found in miner package file: ${file}`);
  }
  for (const required of REQUIRED) {
    if (!paths.includes(required)) throw new Error(`Miner package is missing required file: ${required}`);
  }
  if (!paths.some((file) => /^lib\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/.test(file))) {
    throw new Error("Miner package is missing lib/*.js artifacts");
  }
  return paths;
}

export function runMinerPackCheck(options = {}) {
  const pack = options.pack ?? loadMinerPackFromNpm();
  const packageRoot = options.packageRoot ?? join(process.cwd(), "packages/gittensory-miner");
  const readContent =
    options.readContent ??
    ((file) => {
      if (process.env.CHECK_MINER_PACK_TEST_CONTENT !== undefined) return process.env.CHECK_MINER_PACK_TEST_CONTENT;
      return readFileSync(join(packageRoot, file), "utf8");
    });
  const paths = validateMinerPackFileList(pack.files, readContent);
  return `Miner package dry-run ok: ${paths.join(", ")}\n`;
}

function loadMinerPackFromNpm() {
  if (process.env.CHECK_MINER_PACK_TEST_FILES) {
    const paths = JSON.parse(process.env.CHECK_MINER_PACK_TEST_FILES);
    return { files: paths.map((path) => ({ path })) };
  }
  const result = spawnSync("npm", ["pack", "--workspace", "@jsonbored/gittensory-miner", "--dry-run", "--json"], {
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
    process.stdout.write(runMinerPackCheck());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
