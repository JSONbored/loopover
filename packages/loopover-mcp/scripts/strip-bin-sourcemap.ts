#!/usr/bin/env node
// Strip the trailing inline sourceMappingURL from compiled dist/bin/*.js after tsc.
//
// The package tsconfig uses inlineSourceMap so small lib modules stay coverage-remapable without
// publishing a new *.map file type. For dist/bin/loopover-mcp.js (~6.5k lines) the inline map roughly
// doubles the shipped file past LoopOver's patch-less secrets-scan fetch cap (512KB), which made
// the prior Phase 3 attempt (#7431) fail closed. Bin is subprocess-only tested (mcp-cli harness),
// so v8 never remaps through this file anyway — stripping the map keeps the published/committed
// artifact under the scan cap without changing runtime behavior.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist/bin");
const MARKER = "\n//# sourceMappingURL=";

let stripped = 0;
for (const entry of readdirSync(BIN, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const path = join(BIN, entry.name);
  const before = readFileSync(path, "utf8");
  const idx = before.lastIndexOf(MARKER);
  if (idx === -1) continue;
  writeFileSync(path, before.slice(0, idx) + "\n");
  stripped += 1;
}

console.log(`stripped inline sourcemaps from ${stripped} dist/bin/*.js file(s)`);
