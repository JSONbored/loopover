#!/usr/bin/env node
// Regenerates worker-configuration.d.ts from wrangler.jsonc and strips trailing whitespace -- wrangler's
// raw `wrangler types` output has trailing whitespace on several lines, which fails this repo's own
// `git diff --check` whitespace gate the moment it's committed (mirrors
// packages/discovery-index/scripts/gen-cf-typegen.mjs, found the hard way on that package's own #7167/#4250
// PR). Simpler than the root repo's scripts/gen-cf-typegen.mjs: this package's Env has no `vars`-derived
// Pick<Cloudflare.Env, ...> union to reformat (only a KV binding + ambient-declared secrets), so only the
// whitespace-stripping half of that script's job applies here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function resolveLocalWranglerBin() {
  const pkgJsonPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const binRelativePath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.wrangler;
  return join(dirname(pkgJsonPath), binRelativePath);
}

const OUTPUT_PATH = "worker-configuration.d.ts";

execFileSync(process.execPath, [resolveLocalWranglerBin(), "types", OUTPUT_PATH], { stdio: "inherit" });
const stripped = readFileSync(OUTPUT_PATH, "utf8").replace(/[ \t]+$/gm, "");
writeFileSync(OUTPUT_PATH, stripped);
