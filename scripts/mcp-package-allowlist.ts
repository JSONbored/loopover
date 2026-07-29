// Canonical MCP published-tarball allowlist (#6291). Shared by check-mcp-package.ts and
// mcp-release-candidate-core.ts so the dry-run gate and the release-candidate tarball check
// cannot drift (the previous duplicated lists already missed shipped lib/*.js files).
//
// The dist/ half is DERIVED from the committed TypeScript sources rather than typed out (#9526). Every
// version of this list has failed the same way -- by UNDER-listing, so a legitimately shipped lib/*.js
// tripped the gate that exists to catch strays -- and a list you must remember to extend is a list that
// eventually lags the thing it describes. Reading the source tree keeps the property that matters: the
// tarball may contain the compiled form of committed source and nothing else, so a stray file, a copied
// node_modules artifact, or a build that emits somewhere unexpected still fails loudly.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(fileURLToPath(new URL(".", import.meta.url).href), "..", "packages", "loopover-mcp");

/** `dist/<dir>/<name>.js` for every committed `<dir>/<name>.ts`, as anchored exact-match patterns. */
function compiledOutputPatterns(dir: "bin" | "lib"): RegExp[] {
  return readdirSync(join(PACKAGE_ROOT, dir))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .sort()
    .map((file) => new RegExp(`^dist/${dir}/${file.replace(/\.ts$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.js$`));
}

export const MCP_PACKAGE_ALLOWED_FILE_PATTERNS: RegExp[] = [
  ...compiledOutputPatterns("bin"),
  ...compiledOutputPatterns("lib"),
  /^scripts\/gittensor-score-preview\.(mjs|py)$/,
  /^package\.json$/,
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
];
