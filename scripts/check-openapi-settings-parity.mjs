#!/usr/bin/env tsx
// #2556: RepositorySettingsSchema/RepoSettingsPreviewSchema (src/openapi/schemas.ts) are hand-authored Zod
// schemas -- ui:openapi:check only verifies the generated openapi.json matches THEM, never that they match
// the actual RepositorySettings TS type the API handler serializes. A field added to the TS type (and
// actually returned by GET /v1/repos/:owner/:repo/settings) can silently miss the Zod schema forever, with
// no CI signal -- breaking generated API clients (including @jsonbored/gittensory-mcp) that have no way to
// know about a field the spec doesn't mention. This is a structural key-set diff, not a value/type check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RepositorySettingsSchema } from "../src/openapi/schemas.ts";

export const TYPES_PATH = "src/types.ts";
const TYPE_START = "export type RepositorySettings = {";

/** Pure: extract the top-level field names of the `RepositorySettings` type from raw source text. Every
 *  field is a primitive/union/type-alias reference (never an inline nested object literal), so this never
 *  needs to track brace depth -- verified by direct inspection of the type at the time this check was added. */
export function extractRepositorySettingsFieldNames(source) {
  const startIndex = source.indexOf(TYPE_START);
  if (startIndex === -1) throw new Error(`Could not find "${TYPE_START}" in the given source.`);
  const endIndex = source.indexOf("\n};", startIndex);
  if (endIndex === -1) throw new Error(`Could not find the closing "};" for RepositorySettings in the given source.`);
  const body = source.slice(startIndex + TYPE_START.length, endIndex);
  const fieldPattern = /^ {2}(\w+)\??:/gm;
  const names = new Set();
  for (const match of body.matchAll(fieldPattern)) names.add(match[1]);
  return names;
}

/** Pure: diff two field-name sets, returning the sorted asymmetric differences. */
export function diffFieldSets(typeFields, schemaFields) {
  return {
    missingFromSchema: [...typeFields].filter((field) => !schemaFields.has(field)).sort(),
    extraInSchema: [...schemaFields].filter((field) => !typeFields.has(field)).sort(),
  };
}

function main() {
  const typeFields = extractRepositorySettingsFieldNames(readFileSync(TYPES_PATH, "utf8"));
  const schemaFields = new Set(Object.keys(RepositorySettingsSchema.shape));
  const { missingFromSchema, extraInSchema } = diffFieldSets(typeFields, schemaFields);

  if (missingFromSchema.length > 0 || extraInSchema.length > 0) {
    if (missingFromSchema.length > 0) {
      console.error(`RepositorySettingsSchema (src/openapi/schemas.ts) is missing field(s) present on the RepositorySettings type: ${missingFromSchema.join(", ")}`);
    }
    if (extraInSchema.length > 0) {
      console.error(`RepositorySettingsSchema (src/openapi/schemas.ts) declares field(s) not present on the RepositorySettings type: ${extraInSchema.join(", ")}`);
    }
    console.error("Update src/openapi/schemas.ts, then run: npm run ui:openapi");
    process.exit(1);
  }

  console.log(`RepositorySettingsSchema matches the RepositorySettings type (${typeFields.size} fields).`);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
