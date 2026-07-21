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
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { parse } from "yaml";

const ACTIONS_DIR = ".github/actions";
const SCHEMA_PATH = fileURLToPath(new URL("./schemas/github-action.schema.json", import.meta.url));

export type SchemaValidator = ((doc: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

export type Dirent = { name: string; isDirectory(): boolean };

export type ReaddirFn = (dir: string, options: { withFileTypes: true }) => Dirent[];

export type ReadFileFn = (path: string, encoding?: string) => string | Uint8Array;

/** Compile the vendored action-metadata schema into an Ajv validator. Exported (with the schema JSON
 *  injectable) so tests validate against the real schema without this module reading it off disk. */
export function compileActionSchema(schemaJson: unknown): SchemaValidator {
  const ajv = new Ajv({ allErrors: true, strict: false });
  return ajv.compile(schemaJson as object) as unknown as SchemaValidator;
}

/** Discover action.yml/action.yaml files, one per subdirectory. `readdir`/`readFile` are injected so this
 *  is testable without a real .github/actions tree; a subdirectory with neither file is silently skipped
 *  (the per-candidate readFile throw is the existing fallback). */
export function findActionFiles(actionsDir: string, { readdir, readFile }: { readdir: ReaddirFn; readFile: ReadFileFn }): string[] {
  const results: string[] = [];
  for (const entry of readdir(actionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      const candidate = join(actionsDir, entry.name, name!);
      try {
        readFile(candidate);
        results.push(candidate);
        break; // a directory has one action file, not both
      } catch {
        // try the other extension
      }
    }
  }
  return results;
}

/** Validate one action file's YAML text: JSON-schema violations, plus the composite-only rule that every
 *  `run:` step carries an explicit `shell:`. Returns the human-readable error lines (empty === clean). */
export function validateActionFile(path: string, content: string, validateSchema: SchemaValidator): string[] {
  const errors: string[] = [];
  const doc = parse(content);

  if (!validateSchema(doc)) {
    errors.push(`${path}: schema violations:`);
    for (const err of validateSchema.errors ?? []) {
      errors.push(`  ${err.instancePath || "(root)"} ${err.message}`);
    }
  }

  if (doc?.runs?.using === "composite") {
    for (const [index, step] of (doc.runs.steps ?? []).entries()) {
      if (step.run !== undefined && step.shell === undefined) {
        errors.push(
          `${path}: runs.steps[${index}] ("${step.name ?? "unnamed"}") has a run: but no shell: -- required for composite action steps, unlike a top-level workflow job which defaults to bash`,
        );
      }
    }
  }

  return errors;
}

/** Lint every discovered composite action; returns the process exit code (0 clean / 1 violations). Pure
 *  aside from the injected `readdir`/`readFile`/`validateSchema` and the `log`/`error` sinks. */
export function runLint({
  actionsDir,
  readdir,
  readFile,
  validateSchema,
  log = console.log,
  error = console.error,
}: {
  actionsDir: string;
  readdir: ReaddirFn;
  readFile: ReadFileFn;
  validateSchema: SchemaValidator;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): number {
  const actionFiles = findActionFiles(actionsDir, { readdir, readFile });
  if (actionFiles.length === 0) {
    log(`No composite action files found under ${actionsDir}/ -- nothing to validate.`);
    return 0;
  }

  let hasErrors = false;
  for (const path of actionFiles) {
    const fileErrors = validateActionFile(path, readFile(path, "utf8") as string, validateSchema);
    if (fileErrors.length > 0) {
      hasErrors = true;
      for (const line of fileErrors) error(line);
    }
  }

  if (hasErrors) return 1;
  log(`Validated ${actionFiles.length} composite action file(s) against the GitHub action-metadata schema: all clean.`);
  return 0;
}

// Entrypoint guard (#7459): importing this module for tests exercises the pure validation logic with
// injected inputs; only direct invocation reads the schema/actions tree off disk and exits.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const validateSchema = compileActionSchema(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
  const exitCode = runLint({
    actionsDir: ACTIONS_DIR,
    readdir: readdirSync as unknown as ReaddirFn,
    readFile: (path: string, encoding?: string) => readFileSync(path, encoding as BufferEncoding | undefined),
    validateSchema,
  });
  process.exit(exitCode);
}
