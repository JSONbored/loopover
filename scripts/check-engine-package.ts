#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_CONTENT } from "./forbidden-content.js";

// Unlike MCP/miner's small, hand-curated lib/*.js lists, engine's dist/ mirrors its src/ tree 1:1
// (tsc's default output shape) and grows every time a follow-up issue extracts more logic from the
// app into this package (see the package's own README) -- an enumerated per-file allowlist would need
// editing on every such PR and would silently rot. Pattern-match the dist/ shape itself instead; the
// forbidden-path/forbidden-content/stale-text checks below still catch anything that doesn't belong.
const ALLOWED = [/^dist\/.*\.(js|d\.ts)$/, /^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/];
const REQUIRED = ["package.json", "README.md", "CHANGELOG.md", "dist/index.js", "dist/index.d.ts"];
const FORBIDDEN_PATH = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const STALE_PACKAGE_TEXT = /(private beta|zeronode\.workers\.dev|preview URL)/i;

type PackedFile = string | { path: string };
type ReadContentFn = (file: string) => string;

export function validateEnginePackFileList(files: readonly PackedFile[], readContent: ReadContentFn): string[] {
  const paths = files.map((file) => (typeof file === "string" ? file : file.path)).sort();
  for (const file of paths) {
    if (FORBIDDEN_PATH.test(file)) throw new Error(`Forbidden file in engine package: ${file}`);
    if (!ALLOWED.some((pattern) => pattern.test(file))) throw new Error(`Unexpected file in engine package: ${file}`);
    const content = readContent(file);
    if (FORBIDDEN_CONTENT.test(content)) throw new Error(`Secret-like content found in engine package file: ${file}`);
    if (file === "README.md" && STALE_PACKAGE_TEXT.test(content)) throw new Error(`Stale public-package wording found in engine package file: ${file}`);
  }
  for (const required of REQUIRED) {
    if (!paths.includes(required)) throw new Error(`Engine package is missing required file: ${required}`);
  }
  return paths;
}

export function runEnginePackCheck(options: { pack?: { files: PackedFile[] }; packageRoot?: string; readContent?: ReadContentFn } = {}): string {
  const pack = options.pack ?? loadEnginePackFromNpm();
  const packageRoot = options.packageRoot ?? join(process.cwd(), "packages/loopover-engine");
  const readContent: ReadContentFn =
    options.readContent ??
    ((file) => {
      if (process.env.CHECK_ENGINE_PACK_TEST_CONTENT !== undefined) return process.env.CHECK_ENGINE_PACK_TEST_CONTENT;
      return readFileSync(join(packageRoot, file), "utf8");
    });
  const paths = validateEnginePackFileList(pack.files, readContent);
  return `Engine package dry-run ok: ${paths.length} files.\n`;
}

function loadEnginePackFromNpm(): { files: PackedFile[] } {
  if (process.env.CHECK_ENGINE_PACK_TEST_FILES) {
    const paths: string[] = JSON.parse(process.env.CHECK_ENGINE_PACK_TEST_FILES);
    return { files: paths.map((path) => ({ path })) };
  }
  const result = spawnSync("npm", ["pack", "--workspace", "@loopover/engine", "--dry-run", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || "npm pack failed";
    throw new Error(message.trim());
  }
  return JSON.parse(result.stdout)[0];
}

function main() {
  try {
    process.stdout.write(runEnginePackCheck());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
