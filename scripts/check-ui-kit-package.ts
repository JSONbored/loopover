#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_CONTENT } from "./forbidden-content.js";

// Same reasoning as check-engine-package.ts: dist/ mirrors src/components + src/hooks 1:1 (tsc's default
// output shape, plus .d.ts.map declaration sourcemaps), and grows with every new component -- pattern-match
// the shape instead of enumerating each component file.
const ALLOWED = [/^dist\/.*\.(js|d\.ts|d\.ts\.map)$/, /^src\/theme\.css$/, /^package\.json$/, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/];
const REQUIRED = ["package.json", "README.md", "CHANGELOG.md", "src/theme.css", "dist/utils.js", "dist/utils.d.ts"];
const FORBIDDEN_PATH = /(^|\/)(\.dev\.vars|\.env|\.npmrc|.*\.pem|.*private.*key.*|.*secret.*)$/i;
const STALE_PACKAGE_TEXT = /(private beta|zeronode\.workers\.dev|preview URL)/i;

type PackedFile = string | { path: string };
type ReadContentFn = (file: string) => string;

export function validateUiKitPackFileList(files: readonly PackedFile[], readContent: ReadContentFn): string[] {
  const paths = files.map((file) => (typeof file === "string" ? file : file.path)).sort();
  for (const file of paths) {
    if (FORBIDDEN_PATH.test(file)) throw new Error(`Forbidden file in ui-kit package: ${file}`);
    if (!ALLOWED.some((pattern) => pattern.test(file))) throw new Error(`Unexpected file in ui-kit package: ${file}`);
    const content = readContent(file);
    if (FORBIDDEN_CONTENT.test(content)) throw new Error(`Secret-like content found in ui-kit package file: ${file}`);
    if (file === "README.md" && STALE_PACKAGE_TEXT.test(content)) throw new Error(`Stale public-package wording found in ui-kit package file: ${file}`);
  }
  for (const required of REQUIRED) {
    if (!paths.includes(required)) throw new Error(`ui-kit package is missing required file: ${required}`);
  }
  if (!paths.some((file) => /^dist\/components\/[a-z0-9-]+\.js$/.test(file))) {
    throw new Error("ui-kit package is missing dist/components/*.js artifacts");
  }
  return paths;
}

export function runUiKitPackCheck(options: { pack?: { files: PackedFile[] }; packageRoot?: string; readContent?: ReadContentFn } = {}): string {
  const pack = options.pack ?? loadUiKitPackFromNpm();
  const packageRoot = options.packageRoot ?? join(process.cwd(), "packages/loopover-ui-kit");
  const readContent: ReadContentFn =
    options.readContent ??
    ((file) => {
      if (process.env.CHECK_UI_KIT_PACK_TEST_CONTENT !== undefined) return process.env.CHECK_UI_KIT_PACK_TEST_CONTENT;
      return readFileSync(join(packageRoot, file), "utf8");
    });
  const paths = validateUiKitPackFileList(pack.files, readContent);
  return `ui-kit package dry-run ok: ${paths.length} files.\n`;
}

function loadUiKitPackFromNpm(): { files: PackedFile[] } {
  if (process.env.CHECK_UI_KIT_PACK_TEST_FILES) {
    const paths: string[] = JSON.parse(process.env.CHECK_UI_KIT_PACK_TEST_FILES);
    return { files: paths.map((path) => ({ path })) };
  }
  const result = spawnSync("npm", ["pack", "--workspace", "@loopover/ui-kit", "--dry-run", "--json"], {
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
    process.stdout.write(runUiKitPackCheck());
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
