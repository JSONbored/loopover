import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  compileActionSchema,
  findActionFiles,
  runLint,
  validateActionFile,
  type Dirent,
} from "../../scripts/lint-composite-actions.js";

// #7459: findActionFiles, the schema check, and the shell:-presence check only ran inside the
// disk-reading/process.exit driver. With readdir/readFile/validateSchema injected and the driver behind
// an entrypoint guard, each is now testable against the real vendored schema without a .github/actions tree.

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/schemas/github-action.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const validateSchema = compileActionSchema(schema);

const WELL_FORMED = [
  "name: my-action",
  "description: does a thing",
  "runs:",
  "  using: composite",
  "  steps:",
  "    - name: greet",
  "      run: echo hi",
  "      shell: bash",
].join("\n");

function dir(name: string): Dirent {
  return { name, isDirectory: () => true };
}

describe("validateActionFile (#7459)", () => {
  it("passes a well-formed composite action whose run: steps all carry a shell:", () => {
    expect(validateActionFile(".github/actions/ok/action.yml", WELL_FORMED, validateSchema)).toEqual([]);
  });

  it("flags a composite run: step missing shell: with its exact index and name", () => {
    const content = [
      "name: my-action",
      "description: does a thing",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - name: broken",
      "      run: echo hi",
    ].join("\n");
    const errors = validateActionFile(".github/actions/bad/action.yml", content, validateSchema);
    expect(errors.some((e) => e.includes('runs.steps[0] ("broken")') && e.includes("no shell:"))).toBe(true);
  });

  it("flags a schema violation (action with no runs block at all)", () => {
    const content = ["name: my-action", "description: does a thing"].join("\n");
    const errors = validateActionFile(".github/actions/noruns/action.yml", content, validateSchema);
    expect(errors[0]).toContain("schema violations");
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("findActionFiles (#7459)", () => {
  it("silently skips a subdirectory that has neither action.yml nor action.yaml", () => {
    const readdir = () => [dir("has-neither")];
    const readFile = (path: string) => {
      throw new Error(`ENOENT: ${path}`);
    };
    expect(findActionFiles(".github/actions", { readdir, readFile })).toEqual([]);
  });

  it("finds the single action file (yml preferred) in each subdirectory", () => {
    const readdir = () => [dir("a"), { name: "not-a-dir", isDirectory: () => false }];
    const readFile = (path: string) => {
      if (path.endsWith("a/action.yml")) return "ok";
      throw new Error(`ENOENT: ${path}`);
    };
    expect(findActionFiles(".github/actions", { readdir, readFile })).toEqual([".github/actions/a/action.yml"]);
  });
});

describe("runLint (#7459)", () => {
  it("early-exits 0 when no action files are found", () => {
    const messages: string[] = [];
    const code = runLint({
      actionsDir: ".github/actions",
      readdir: () => [],
      readFile: () => "",
      validateSchema,
      log: (m) => messages.push(m),
      error: () => {},
    });
    expect(code).toBe(0);
    expect(messages.some((m) => m.includes("nothing to validate"))).toBe(true);
  });

  it("returns 1 and reports the error when a discovered action file is invalid", () => {
    const content = [
      "name: my-action",
      "description: does a thing",
      "runs:",
      "  using: composite",
      "  steps:",
      "    - run: echo hi",
    ].join("\n");
    const errors: string[] = [];
    const code = runLint({
      actionsDir: ".github/actions",
      readdir: () => [dir("bad")],
      readFile: (path: string, encoding?: string) => {
        if (encoding === "utf8") return content;
        return "exists";
      },
      validateSchema,
      log: () => {},
      error: (m) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.some((e) => e.includes("no shell:"))).toBe(true);
  });

  it("returns 0 for a clean discovered action file", () => {
    const code = runLint({
      actionsDir: ".github/actions",
      readdir: () => [dir("ok")],
      readFile: (path: string, encoding?: string) => (encoding === "utf8" ? WELL_FORMED : "exists"),
      validateSchema,
      log: () => {},
      error: () => {},
    });
    expect(code).toBe(0);
  });
});
