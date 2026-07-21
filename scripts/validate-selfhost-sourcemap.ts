#!/usr/bin/env node
// Validates that the self-host Docker build's dist/server.mjs + dist/server.mjs.map are structurally
// sound and resolve back to real repository source (not an empty/broken map). Gates error.stack
// symbolication for every self-hosted deployment. Invoked from release-selfhost.yml and selfhost.yml.
//
// #7458: validation is an injectable named export so unit tests can cover every failure branch without
// a real dist/ build. The CLI entrypoint below preserves the previous cwd-relative + exit-1 behavior.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ValidateSourcemapOptions = {
  bundlePath?: string;
  mapPath?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
};

type SourceMapLike = {
  version?: unknown;
  sources?: unknown;
  sourcesContent?: unknown;
};

export function validateSourcemap(options: ValidateSourcemapOptions = {}): { sourceCount: number } {
  const bundlePath = options.bundlePath ?? resolve(process.cwd(), "dist/server.mjs");
  const mapPath = options.mapPath ?? resolve(process.cwd(), "dist/server.mjs.map");
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  if (!exists(bundlePath)) throw new Error("dist/server.mjs is missing");
  if (!exists(mapPath)) throw new Error("dist/server.mjs.map is missing");

  const bundle = readFile(bundlePath);
  if (!bundle.includes("//# sourceMappingURL=server.mjs.map")) {
    throw new Error("dist/server.mjs is missing the server.mjs.map sourceMappingURL");
  }

  let map: SourceMapLike;
  try {
    map = JSON.parse(readFile(mapPath));
  } catch (error) {
    throw new Error(`dist/server.mjs.map is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }

  if (map.version !== 3) throw new Error("dist/server.mjs.map is not a version 3 source map");
  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    throw new Error("dist/server.mjs.map has no original sources");
  }
  if (!Array.isArray(map.sourcesContent) || map.sourcesContent.length !== map.sources.length) {
    throw new Error("dist/server.mjs.map must include sourcesContent for every original source");
  }
  const sources: unknown[] = map.sources;
  const sourcesContent: unknown[] = map.sourcesContent;
  const serverSourceIndex = sources.findIndex((source) => String(source).endsWith("src/server.ts"));
  if (serverSourceIndex === -1) {
    throw new Error("dist/server.mjs.map does not include src/server.ts");
  }
  if (String(sourcesContent[serverSourceIndex] ?? "").trim() === "") {
    throw new Error("dist/server.mjs.map has empty source content for src/server.ts");
  }
  const repoSourceIndexes = sources
    .map((source, index): [string, number] => [String(source), index])
    .filter(([source]) => source.startsWith("../src/"))
    .map(([, index]) => index);
  if (repoSourceIndexes.length === 0) {
    throw new Error("dist/server.mjs.map does not include repository sources");
  }
  if (repoSourceIndexes.some((index) => typeof sourcesContent[index] !== "string" || (sourcesContent[index] as string).trim() === "")) {
    throw new Error("dist/server.mjs.map is missing source content for a repository source");
  }

  return { sourceCount: sources.length };
}

function fail(message: string): never {
  console.error(`self-host sourcemap validation failed: ${message}`);
  process.exit(1);
}

function main() {
  try {
    const { sourceCount } = validateSourcemap();
    console.log(`self-host sourcemap validation passed (${sourceCount} original sources)`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
