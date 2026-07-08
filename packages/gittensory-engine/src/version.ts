import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

// Read at runtime instead of a hand-synced literal -- works identically from src/version.ts
// (source, under vitest) and dist/version.js (compiled output): package.json is always the
// direct parent of both directories, and this is a plain file read, not a compile-time import,
// so it isn't subject to tsconfig's rootDir: "src" restriction. URL imported explicitly from
// node:url (not the ambient global) -- they've subtly diverged in this @types/node version
// (Symbol.dispose on URLSearchParamsIterator), which fileURLToPath's overloads reject otherwise.
const ownPackageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const ownPackageJson = JSON.parse(readFileSync(ownPackageJsonPath, "utf8")) as { version: string };

/** Published semver of `@jsonbored/gittensory-engine`, derived from this package's own package.json. */
export const ENGINE_VERSION: string = ownPackageJson.version;
