#!/usr/bin/env tsx
// #2556: RepositorySettingsSchema/RepoSettingsPreviewSchema (src/openapi/schemas.ts) are hand-authored Zod
// schemas -- ui:openapi:check only verifies the generated openapi.json matches THEM, never that they match
// the actual RepositorySettings TS type the API handler serializes. A field added to the TS type (and
// actually returned by GET /v1/repos/:owner/:repo/settings) can silently miss the Zod schema forever, with
// no CI signal -- breaking generated API clients (including @loopover/mcp) that have no way to
// know about a field the spec doesn't mention. This is a structural key-set diff, not a value/type check.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RepositorySettingsSchema, RepoSettingsPreviewSchema } from "../src/openapi/schemas.js";

export const TYPES_PATH = "src/types.ts";
const TYPE_START = "export type RepositorySettings = {";

// #7011: RepoSettingsPreviewSchema.settings (the nested settings object of the settings-preview response) is a
// second hand-authored Zod schema this check's header names -- its source of truth is buildRepoSettingsPreview's
// return shape, whose named return type is RepoSettingsPreview (src/signals/settings-preview.ts). A field added
// to (or dropped from) that builder without a matching schema edit would otherwise drift with no CI signal,
// exactly as for RepositorySettings above.
export const SETTINGS_PREVIEW_PATH = "src/signals/settings-preview.ts";
const PREVIEW_TYPE_START = "export type RepoSettingsPreview = {";
const PREVIEW_SETTINGS_START = "  settings: {";

/** Pure: extract the top-level field names of the `RepositorySettings` type from raw source text. Every
 *  field is a primitive/union/type-alias reference (never an inline nested object literal), so this never
 *  needs to track brace depth -- verified by direct inspection of the type at the time this check was added. */
export function extractRepositorySettingsFieldNames(source: string): Set<string> {
  const startIndex = source.indexOf(TYPE_START);
  if (startIndex === -1) throw new Error(`Could not find "${TYPE_START}" in the given source.`);
  const endIndex = source.indexOf("\n};", startIndex);
  if (endIndex === -1) throw new Error(`Could not find the closing "};" for RepositorySettings in the given source.`);
  const body = source.slice(startIndex + TYPE_START.length, endIndex);
  const fieldPattern = /^ {2}(\w+)\??:/gm;
  const names = new Set<string>();
  for (const match of body.matchAll(fieldPattern)) names.add(match[1]!);
  return names;
}

/** Pure: extract the field names of the nested `settings` object of the `RepoSettingsPreview` type from raw
 *  source text. Unlike RepositorySettings, this block nests one inline object literal (`commandAuthorization`),
 *  so we brace-match to bound the settings body precisely, then take only its direct children (4-space indent);
 *  the nested members sit deeper and never match the anchor. */
export function extractRepoSettingsPreviewFieldNames(source: string): Set<string> {
  const typeIndex = source.indexOf(PREVIEW_TYPE_START);
  if (typeIndex === -1) throw new Error(`Could not find "${PREVIEW_TYPE_START}" in the given source.`);
  const blockIndex = source.indexOf(PREVIEW_SETTINGS_START, typeIndex);
  if (blockIndex === -1) throw new Error(`Could not find the "settings" block of RepoSettingsPreview in the given source.`);
  const openBrace = blockIndex + PREVIEW_SETTINGS_START.length - 1;
  let depth = 0;
  let endIndex = -1;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) throw new Error(`Could not find the closing "}" for the RepoSettingsPreview settings block in the given source.`);
  const body = source.slice(openBrace + 1, endIndex);
  const fieldPattern = /^ {4}(\w+)\??:/gm;
  const names = new Set<string>();
  for (const match of body.matchAll(fieldPattern)) names.add(match[1]!);
  return names;
}

/** Pure: diff two field-name sets, returning the sorted asymmetric differences. */
export function diffFieldSets(typeFields: ReadonlySet<string>, schemaFields: ReadonlySet<string>): { missingFromSchema: string[]; extraInSchema: string[] } {
  return {
    missingFromSchema: [...typeFields].filter((field) => !schemaFields.has(field)).sort(),
    extraInSchema: [...schemaFields].filter((field) => !typeFields.has(field)).sort(),
  };
}

function main() {
  let failed = false;

  const typeFields = extractRepositorySettingsFieldNames(readFileSync(TYPES_PATH, "utf8"));
  const schemaFields = new Set(Object.keys(RepositorySettingsSchema.shape));
  const repo = diffFieldSets(typeFields, schemaFields);
  if (repo.missingFromSchema.length > 0 || repo.extraInSchema.length > 0) {
    if (repo.missingFromSchema.length > 0) {
      console.error(`RepositorySettingsSchema (src/openapi/schemas.ts) is missing field(s) present on the RepositorySettings type: ${repo.missingFromSchema.join(", ")}`);
    }
    if (repo.extraInSchema.length > 0) {
      console.error(`RepositorySettingsSchema (src/openapi/schemas.ts) declares field(s) not present on the RepositorySettings type: ${repo.extraInSchema.join(", ")}`);
    }
    console.error("Update src/openapi/schemas.ts, then run: npm run ui:openapi");
    failed = true;
  } else {
    console.log(`RepositorySettingsSchema matches the RepositorySettings type (${typeFields.size} fields).`);
  }

  const previewTypeFields = extractRepoSettingsPreviewFieldNames(readFileSync(SETTINGS_PREVIEW_PATH, "utf8"));
  const previewSchemaFields = new Set(Object.keys(RepoSettingsPreviewSchema.shape.settings.shape));
  const preview = diffFieldSets(previewTypeFields, previewSchemaFields);
  if (preview.missingFromSchema.length > 0 || preview.extraInSchema.length > 0) {
    if (preview.missingFromSchema.length > 0) {
      console.error(`RepoSettingsPreviewSchema.settings (src/openapi/schemas.ts) is missing field(s) present on buildRepoSettingsPreview's return shape (RepoSettingsPreview.settings, src/signals/settings-preview.ts): ${preview.missingFromSchema.join(", ")}`);
    }
    if (preview.extraInSchema.length > 0) {
      console.error(`RepoSettingsPreviewSchema.settings (src/openapi/schemas.ts) declares field(s) not present on buildRepoSettingsPreview's return shape (RepoSettingsPreview.settings, src/signals/settings-preview.ts): ${preview.extraInSchema.join(", ")}`);
    }
    console.error("Update src/openapi/schemas.ts, then run: npm run ui:openapi");
    failed = true;
  } else {
    console.log(`RepoSettingsPreviewSchema.settings matches buildRepoSettingsPreview's return shape (${previewTypeFields.size} fields).`);
  }

  if (failed) process.exit(1);
}

// Guard so importing this module for its pure exports (tests) never triggers the file-read/exit side effects.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
