import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .filter((path) => statSync(path).isFile())
    .sort();
}

if (!existsSync(distDir)) fail("review-enrichment/dist is missing; run npm run build first");

const serverBundle = resolve(distDir, "server.js");
const serverMap = resolve(distDir, "server.js.map");
if (!existsSync(serverBundle)) fail("review-enrichment/dist/server.js is missing");
if (!existsSync(serverMap)) fail("review-enrichment/dist/server.js.map is missing");

const bundle = readFileSync(serverBundle, "utf8");
if (!bundle.includes("//# sourceMappingURL=server.js.map")) {
  fail("review-enrichment/dist/server.js is missing the server.js.map sourceMappingURL");
}

const maps = listFiles(distDir).filter((path) => path.endsWith(".js.map"));
if (maps.length === 0) fail("review-enrichment/dist has no JavaScript source maps");

let sawServerSource = false;
for (const path of maps) {
  let map;
  try {
    map = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relative(root, path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    fail(`${relative(root, path)} has no original sources`);
  }
  if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
    fail(`${relative(root, path)} does not embed sourcesContent for every source`);
  }
  if (!map.sourcesContent.some((source) => typeof source === "string" && source.trim().length > 0)) {
    fail(`${relative(root, path)} has empty sourcesContent`);
  }
  if (map.sources.some((source) => String(source).replaceAll("\\", "/").endsWith("src/server.ts"))) {
    sawServerSource = true;
  }
}

if (!sawServerSource) fail("review-enrichment source maps do not include src/server.ts");

console.log(`validated ${maps.length} REES source map${maps.length === 1 ? "" : "s"}`);
