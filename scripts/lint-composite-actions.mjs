#!/usr/bin/env node
// Validates every .github/actions/*/action.yml against GitHub's official action-metadata JSON Schema,
// plus one composite-action-specific check the schema can't express: every `run:` step needs an
// explicit `shell:` (unlike a top-level workflow job, which defaults to bash on a Linux runner -- a
// missing one in a composite action is a silent hard failure at actual run time, not a parse-time
// error).
//
// actionlint (this repo's usual workflow linter, scripts/actionlint.mjs) does NOT support action.yml
// files at all -- confirmed this is a genuine, long-standing upstream limitation
// (github.com/rhysd/actionlint/issues/46 and /issues/401, open since 2021), not a configuration gap on
// this repo's side: even the raw actionlint binary, invoked directly with no wrapper, treats any file
// it's given as a workflow and errors on `runs`/`inputs`/`outputs` as unexpected top-level keys. This
// script is the closest available substitute -- real structural/schema validation, not the full
// expression-context linting actionlint does for workflows, which genuinely doesn't exist anywhere for
// action.yml files.
//
// Schema vendored locally (scripts/schemas/github-action.schema.json, from
// https://json.schemastore.org/github-action.json) rather than fetched live, so this check doesn't
// depend on network access in CI -- consistent with how the rest of this repo's drift/lint checks work
// offline against committed state.

import Ajv from "ajv";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ACTIONS_DIR = ".github/actions";
const SCHEMA_PATH = new URL("./schemas/github-action.schema.json", import.meta.url);

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

function findActionFiles() {
  const results = [];
  for (const entry of readdirSync(ACTIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      const candidate = join(ACTIONS_DIR, entry.name, name);
      try {
        readFileSync(candidate);
        results.push(candidate);
        break; // a directory has one action file, not both
      } catch {
        // try the other extension
      }
    }
  }
  return results;
}

const actionFiles = findActionFiles();
if (actionFiles.length === 0) {
  console.log(`No composite action files found under ${ACTIONS_DIR}/ -- nothing to validate.`);
  process.exit(0);
}

let hasErrors = false;

for (const path of actionFiles) {
  const doc = parse(readFileSync(path, "utf8"));

  if (!validateSchema(doc)) {
    hasErrors = true;
    console.error(`${path}: schema violations:`);
    for (const err of validateSchema.errors ?? []) {
      console.error(`  ${err.instancePath || "(root)"} ${err.message}`);
    }
  }

  if (doc?.runs?.using === "composite") {
    for (const [index, step] of (doc.runs.steps ?? []).entries()) {
      if (step.run !== undefined && step.shell === undefined) {
        hasErrors = true;
        console.error(
          `${path}: runs.steps[${index}] ("${step.name ?? "unnamed"}") has a run: but no shell: -- required for composite action steps, unlike a top-level workflow job which defaults to bash`,
        );
      }
    }
  }
}

if (hasErrors) {
  process.exit(1);
}
console.log(`Validated ${actionFiles.length} composite action file(s) against the GitHub action-metadata schema: all clean.`);
