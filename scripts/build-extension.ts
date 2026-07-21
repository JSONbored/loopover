import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createStoredZip } from "./extension-zip-core.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "apps/loopover-extension");
const outDir = resolve(root, "apps/loopover-extension/dist/package");
const zipPath = resolve(root, "apps/loopover-ui/public/downloads/loopover-extension.zip");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(dirname(zipPath), { recursive: true });

for (const file of ["manifest.json", "auth.js", "background.js", "content.js", "styles.css", "options.html", "options.js"]) {
  cpSync(resolve(source, file), resolve(outDir, file));
}

rmSync(zipPath, { force: true });
writeFileSync(zipPath, createStoredZip(outDir));

console.log(`wrote ${zipPath.replace(`${root}/`, "")}`);
