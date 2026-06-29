import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const bundlePath = resolve(root, "dist/server.mjs");
const mapPath = resolve(root, "dist/server.mjs.map");

function fail(message) {
  console.error(`self-host sourcemap validation failed: ${message}`);
  process.exit(1);
}

if (!existsSync(bundlePath)) fail("dist/server.mjs is missing");
if (!existsSync(mapPath)) fail("dist/server.mjs.map is missing");

const bundle = readFileSync(bundlePath, "utf8");
if (!bundle.includes("//# sourceMappingURL=server.mjs.map")) {
  fail("dist/server.mjs is missing the server.mjs.map sourceMappingURL");
}

let map;
try {
  map = JSON.parse(readFileSync(mapPath, "utf8"));
} catch (error) {
  fail(`dist/server.mjs.map is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
}

if (map.version !== 3) fail("dist/server.mjs.map is not a version 3 source map");
if (!Array.isArray(map.sources) || map.sources.length === 0) {
  fail("dist/server.mjs.map has no original sources");
}
if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
  fail("dist/server.mjs.map must include sourcesContent for every original source");
}
const serverSourceIndex = map.sources.findIndex((source) =>
  String(source).endsWith("src/server.ts"),
);
if (serverSourceIndex === -1) {
  fail("dist/server.mjs.map does not include src/server.ts");
}
if (map.sourcesContent[serverSourceIndex]?.trim() === "") {
  fail("dist/server.mjs.map has empty source content for src/server.ts");
}
const repoSourceIndexes = map.sources
  .map((source, index) => [String(source), index])
  .filter(([source]) => source.startsWith("../src/"))
  .map(([, index]) => index);
if (repoSourceIndexes.length === 0) {
  fail("dist/server.mjs.map does not include repository sources");
}
if (
  repoSourceIndexes.some(
    (index) =>
      typeof map.sourcesContent[index] !== "string" ||
      map.sourcesContent[index].trim() === "",
  )
) {
  fail("dist/server.mjs.map is missing source content for a repository source");
}

console.log(
  `self-host sourcemap validation passed (${map.sources.length} original sources)`,
);
