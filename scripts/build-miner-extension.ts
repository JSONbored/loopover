import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStoredZip } from "./extension-zip-core.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "apps/loopover-miner-extension");
const outDir = resolve(source, "dist/package");

const PACKAGE_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "opportunity-badge.js",
  "options.html",
  "options.js",
  "styles.css",
  "toolbar-badge.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of PACKAGE_FILES) {
  const dest = resolve(outDir, file);
  mkdirSync(dirname(dest), { recursive: true }); // create nested dirs (e.g. icons/) before copying
  cpSync(resolve(source, file), dest);
}

const zipPath = resolve(source, "dist/loopover-miner-extension.zip");
rmSync(zipPath, { force: true });
writeFileSync(zipPath, createStoredZip(outDir));

console.log(`wrote ${relative(root, zipPath)}`);
