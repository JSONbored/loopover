import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSelfHostEnvVars,
  renderSelfHostEnvReferenceMarkdown,
  writeSelfHostEnvReference,
} from "../../scripts/gen-selfhost-env-reference";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gt-env-reference-"));
  mkdirSync(join(root, "src", "selfhost", "nested"), { recursive: true });
  writeFileSync(
    join(root, "src", "selfhost", "a.ts"),
    [
      "export const ignored = process.env.not_upper;",
      "const second = process.env.SECOND;",
      "const first = process.env.FIRST;",
      "const bracket = process.env['BRACKET_ONLY'];",
      "const { DESTRUCTURED, ALIASED_ENV: alias, DEFAULTED_ENV = 'fallback' } = process.env;",
      "const helper = nonBlank(env.HELPER_ONLY);",
      "const binding = env.DB;",
      "const objectBracket = env['OBJECT_BRACKET'];",
      "const { OBJECT_DESTRUCTURED, OBJECT_ALIASED: local } = env;",
      "const ctx = c.env.CTX_ONLY;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "selfhost", "nested", "b.ts"),
    [
      "const duplicateSecond = process.env.SECOND;",
      "const nested = process.env.NESTED_ONLY;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "src", "server.ts"),
    [
      "const serverOnly = process.env.SERVER_ONLY;",
      "const duplicateFirst = process.env.FIRST;",
      "",
    ].join("\n"),
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "selfhost-smoke.mjs"), "const scriptOnly = process.env.SCRIPT_ONLY;\n");
  mkdirSync(join(root, "src", "services"), { recursive: true });
  writeFileSync(
    join(root, "src", "services", "notify-discord.ts"),
    [
      "const serviceOnly = process.env.SERVICE_ONLY;",
      "const helperOnly = envString(env, 'SERVICE_HELPER_ONLY');",
      "const casted = (env as unknown as Record<string, unknown>).CASTED_ONLY;",
      "const parsedInt = parsePositiveIntEnv('PARSED_INT_ONLY', { min: 1, fallback: 4 });",
      "const loopoverOnly = env.LOOPOVER_PLAIN_ONLY;",
      "",
    ].join("\n"),
  );
  return root;
}

describe("gen-selfhost-env-reference (#2081)", () => {
  it("extracts static env reads and keeps the first source reference", () => {
    expect(collectSelfHostEnvVars({ rootDir: fixtureRoot() })).toEqual([
      { name: "ALIASED_ENV", firstReference: "src/selfhost/a.ts" },
      { name: "BRACKET_ONLY", firstReference: "src/selfhost/a.ts" },
      { name: "CASTED_ONLY", firstReference: "src/services/notify-discord.ts" },
      { name: "CTX_ONLY", firstReference: "src/selfhost/a.ts" },
      { name: "DEFAULTED_ENV", firstReference: "src/selfhost/a.ts" },
      { name: "DESTRUCTURED", firstReference: "src/selfhost/a.ts" },
      { name: "FIRST", firstReference: "src/selfhost/a.ts" },
      { name: "HELPER_ONLY", firstReference: "src/selfhost/a.ts" },
      { name: "LOOPOVER_PLAIN_ONLY", firstReference: "src/services/notify-discord.ts" },
      { name: "NESTED_ONLY", firstReference: "src/selfhost/nested/b.ts" },
      { name: "OBJECT_ALIASED", firstReference: "src/selfhost/a.ts" },
      { name: "OBJECT_BRACKET", firstReference: "src/selfhost/a.ts" },
      { name: "OBJECT_DESTRUCTURED", firstReference: "src/selfhost/a.ts" },
      { name: "PARSED_INT_ONLY", firstReference: "src/services/notify-discord.ts" },
      { name: "SECOND", firstReference: "src/selfhost/a.ts" },
      { name: "SERVER_ONLY", firstReference: "src/server.ts" },
      { name: "SERVICE_HELPER_ONLY", firstReference: "src/services/notify-discord.ts" },
      { name: "SERVICE_ONLY", firstReference: "src/services/notify-discord.ts" },
    ]);
  });

  it("REGRESSION (#env-reference-churn): firstReference is immune to line shifts elsewhere in the file", () => {
    const root = mkdtempSync(join(tmpdir(), "gt-env-reference-lineshift-"));
    mkdirSync(join(root, "src", "selfhost"), { recursive: true });
    const filePath = join(root, "src", "selfhost", "a.ts");
    const read = "const value = process.env.STABLE_VAR;\n";

    writeFileSync(filePath, read);
    const before = collectSelfHostEnvVars({ rootDir: root });
    expect(before).toEqual([{ name: "STABLE_VAR", firstReference: "src/selfhost/a.ts" }]);

    // Ten unrelated lines added ABOVE the same read -- a real PR touching this file for an unrelated reason
    // would shift STABLE_VAR from line 1 to line 11 under the old file:line format, changing the generated
    // output and colliding with any other PR that regenerated it from a different line count.
    writeFileSync(filePath, "// unrelated change\n".repeat(10) + read);
    const after = collectSelfHostEnvVars({ rootDir: root });
    expect(after).toEqual(before);
  });

  it("REGRESSION (#8652): detects env reads inside a for-of over a locally-declared literal-name array", () => {
    const root = mkdtempSync(join(tmpdir(), "gt-env-reference-forof-"));
    mkdirSync(join(root, "src", "selfhost"), { recursive: true });
    // Mirrors src/selfhost/preflight.ts's CRITICAL_SECRET_VARS loop: the var names come from iterating a local
    // const array of string literals, and `env[name]` is a computed access whose argument is the loop variable,
    // not a string literal -- invisible to the plain element-access branch.
    writeFileSync(
      join(root, "src", "selfhost", "loops.ts"),
      [
        'const SECRET_VARS = ["ALPHA_TOKEN", "BETA_TOKEN"] as const;',
        "for (const name of SECRET_VARS) {",
        "  const value = nonBlank(env[name]);",
        "  void value;",
        "}",
        // Negative: a literal-name array whose loop never touches env must NOT be surfaced.
        'const UNUSED_VARS = ["GAMMA_UNUSED"];',
        "for (const label of UNUSED_VARS) {",
        "  console.log(label);",
        "}",
        // Negative: destructuring loop variable over a known literal array is not a plain `env[name]` read.
        "for (const [first] of SECRET_VARS) {",
        "  void first;",
        "}",
        // Negative: an assignment-target loop (no `const` declaration list) is ignored.
        "let reused;",
        "for (reused of SECRET_VARS) {",
        "  void reused;",
        "}",
        // Negative: iterable is a call expression, not an identifier -> ignored.
        "for (const other of Object.keys(env)) {",
        "  void other;",
        "}",
        // Negative: iterable identifier is not a collected literal-string array -> ignored.
        "for (const missing of NOT_DECLARED_HERE) {",
        "  void env[missing];",
        "}",
        // Non-string / empty arrays are never treated as literal-name arrays.
        "const NUMBERS = [1, 2, 3];",
        "const EMPTY_ARRAY = [];",
        "for (const n of NUMBERS) {",
        "  void n;",
        "}",
        "void EMPTY_ARRAY;",
        "",
      ].join("\n"),
    );
    expect(collectSelfHostEnvVars({ rootDir: root })).toEqual([
      { name: "ALPHA_TOKEN", firstReference: "src/selfhost/loops.ts" },
      { name: "BETA_TOKEN", firstReference: "src/selfhost/loops.ts" },
    ]);
  });

  it("scans configured JavaScript roots and rejects file-shaped directories", () => {
    const root = fixtureRoot();

    expect(
      collectSelfHostEnvVars({
        rootDir: root,
        sourceRoots: ["scripts/selfhost-smoke.mjs"],
      }),
    ).toEqual([{ name: "SCRIPT_ONLY", firstReference: "scripts/selfhost-smoke.mjs" }]);

    mkdirSync(join(root, "src", "selfhost", "bad.ts"));
    expect(() =>
      collectSelfHostEnvVars({
        rootDir: root,
        sourceRoots: ["src/selfhost/bad.ts"],
      }),
    ).toThrow(/looks like a file but is a directory/);
  });

  it("renders a deterministic Markdown table with names and references only", () => {
    expect(
      renderSelfHostEnvReferenceMarkdown([
        { name: "FIRST", firstReference: "src/selfhost/a.ts" },
        { name: "SECOND", firstReference: "src/server.ts" },
      ]),
    ).toBe(
      [
        "| Name | First reference |",
        "| --- | --- |",
        "| `FIRST` | `src/selfhost/a.ts` |",
        "| `SECOND` | `src/server.ts` |",
      ].join("\n"),
    );
  });

  it("writes the generated module and reports stale output in check mode", () => {
    const root = fixtureRoot();
    const outputPath = "apps/loopover-ui/src/lib/selfhost-env-reference.ts";
    const outputAbs = join(root, outputPath);

    const written = writeSelfHostEnvReference({ rootDir: root, outputPath });
    expect(written.changed).toBe(true);
    expect(existsSync(outputAbs)).toBe(true);
    const generated = readFileSync(outputAbs, "utf8");
    expect(generated).toContain("SELFHOST_ENV_REFERENCE_MARKDOWN");
    expect(generated).toContain("src/selfhost/a.ts");

    expect(writeSelfHostEnvReference({ rootDir: root, outputPath, check: true }).changed).toBe(false);

    writeFileSync(outputAbs, "stale\n");
    const stale = writeSelfHostEnvReference({ rootDir: root, outputPath, check: true });
    expect(stale.changed).toBe(true);
    expect(readFileSync(outputAbs, "utf8")).toBe("stale\n");

    const rewritten = writeSelfHostEnvReference({ rootDir: root, outputPath });
    expect(rewritten.changed).toBe(true);
    expect(readFileSync(outputAbs, "utf8")).toBe(generated);
  });
});

describe("PostHog self-host env reads invisible to the visitor (#8627)", () => {
  function rootWith(source: string): string {
    const root = mkdtempSync(join(tmpdir(), "gt-env-reference-8627-"));
    mkdirSync(join(root, "src", "selfhost"), { recursive: true });
    writeFileSync(join(root, "src", "selfhost", "posthog.ts"), source);
    return root;
  }

  function collectedNames(root: string): string[] {
    return collectSelfHostEnvVars({ rootDir: root }).map((row) => row.name);
  }

  it("recognizes a .env property access whose base is globalThis.process behind an `as unknown as` cast", () => {
    // The exact shape src/selfhost/posthog.ts uses to read POSTHOG_SERVER_NAME: the base of `.env` is a
    // property access on a cast expression, not a bare `process` identifier.
    const root = rootWith(
      "const serverName = nonBlank((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.POSTHOG_SERVER_NAME) ?? hostname();\n",
    );
    expect(collectSelfHostEnvVars({ rootDir: root })).toEqual([{ name: "POSTHOG_SERVER_NAME", firstReference: "src/selfhost/posthog.ts" }]);
  });

  it("does NOT match the cast shape when the .process base is not globalThis", () => {
    // Same cast-and-property-access silhouette, different base identifier: the new branch must not treat any
    // `<something>.process.env` as the ambient process env.
    const root = rootWith(
      "const serverName = ((someScope as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NOT_AMBIENT_PROCESS_READ);\n",
    );
    expect(collectedNames(root)).toEqual([]);
  });

  it("captures both env var name literals of a resolveSeverityThreshold call", () => {
    // The exact call shape of src/selfhost/posthog.ts's resolvePostHogMinSeverity: env var names appear only
    // as string-literal arguments 2 and 3 -- the reads inside the helper are computed and AST-invisible.
    const root = rootWith(
      'const severity = resolveSeverityThreshold(processEnv as unknown as Env, repoFullName, "POSTHOG_MIN_SEVERITY", "POSTHOG_REPO_MIN_SEVERITY");\n',
    );
    expect(collectedNames(root)).toEqual(["POSTHOG_MIN_SEVERITY", "POSTHOG_REPO_MIN_SEVERITY"]);
  });

  it("does NOT capture name-shaped literals passed to a call outside the helper allowlist", () => {
    // A same-arity call to a different function must stay invisible: recognition is keyed on the helper name,
    // not on any string literal that merely looks like an env var name.
    const root = rootWith(
      'const severity = resolveSeverityCeiling(processEnv as unknown as Env, repoFullName, "NOT_CAPTURED_GLOBAL", "NOT_CAPTURED_REPO_MAP");\n',
    );
    expect(collectedNames(root)).toEqual([]);
  });
});

describe("AI review-pipeline self-host env vars (#6993)", () => {
  it("scans the AI review source roots so their self-host AI_* vars are collected", () => {
    // Against the REAL repo with the default (now-extended) source roots: the four AI review-pipeline knobs are
    // read in src/services/ai-review.ts etc., not under src/selfhost, so they only surface once those roots are
    // scanned. Before #6993 none of these appeared in the generated reference.
    const byName = new Map(collectSelfHostEnvVars({}).map((row) => [row.name, row.firstReference]));
    for (const name of ["AI_SUMMARIES_ENABLED", "AI_PUBLIC_COMMENTS_ENABLED", "AI_MAX_OUTPUT_TOKENS", "AI_BYOK_DAILY_REPO_LIMIT"]) {
      expect(byName.has(name), name).toBe(true);
    }
    // AI_MAX_OUTPUT_TOKENS is read only in ai-review.ts, so its first reference proves the new root is the source.
    expect(byName.get("AI_MAX_OUTPUT_TOKENS")).toBe("src/services/ai-review.ts");
  });
});

describe("same-file parameter-forwarding wrapper functions (#8651)", () => {
  function collectFrom(source: string): string[] {
    const root = mkdtempSync(join(tmpdir(), "gt-env-reference-8651-"));
    mkdirSync(join(root, "src", "selfhost"), { recursive: true });
    writeFileSync(join(root, "src", "selfhost", "wrappers.ts"), source);
    return collectSelfHostEnvVars({ rootDir: root }).map((row) => row.name);
  }

  it("detects a wrapper forwarding its name parameter into parsePositiveIntEnv / process.env / envString / a chained wrapper", () => {
    const source = [
      // wrapper -> parsePositiveIntEnv (PROCESS_ENV_NAME_HELPERS); the console.log/plainCall decoys exercise the
      // non-identifier-callee and unrecognized-callee branches of callForwardsParamAsName.
      "function wrapInt(name, fallback) {",
      "  console.log(name);",
      "  plainCall(name);",
      "  return parsePositiveIntEnv(name, { min: 0, fallback });",
      "}",
      // wrapper -> direct process.env[name] read.
      "function wrapFloat(name) {",
      "  return process.env[name];",
      "}",
      // wrapper-of-wrapper: forwards into wrapMap (declared AFTER it), forcing a second fixpoint iteration.
      "function wrapOuter(k) {",
      "  return wrapMap(env, k);",
      "}",
      // wrapper -> envString(env, envName) with the param at arg index 1.
      "function wrapMap(env, envName) {",
      "  return envString(env, envName);",
      "}",
      // wrapper -> a literal-arg helper (resolveLocalStoreDbPath reads env at arg index 1).
      "function wrapLocal(p) {",
      "  return resolveLocalStoreDbPath(base, p);",
      "}",
      // arrow-function and function-expression wrapper forms.
      "const wrapArrow = (name) => parsePositiveIntEnv(name, { fallback: 2 });",
      "const wrapFnExpr = function (name) { return parsePositiveIntEnv(name, { fallback: 9 }); };",
      // NOT a wrapper: never forwards its parameter into an env sink.
      "function notWrapper(name) {",
      "  return name.length;",
      "}",
      // Call sites with literal names -> collected. Non-literal and non-wrapper calls -> ignored.
      'const a = wrapInt("ALPHA_MS", 1);',
      'const b = wrapFloat("BETA_LOAD");',
      'const c = wrapOuter("DELTA_CHAIN");',
      'const d = wrapMap(env, "GAMMA_MAP");',
      'const e = wrapArrow("EPSILON_MS");',
      'const f = wrapLocal("ZETA_DB");',
      'const g = wrapFnExpr("ETA_MS");',
      "const h = wrapInt(dynamicName, 3);",
      'const i = notWrapper("NOT_ENV");',
      "",
    ].join("\n");
    expect(collectFrom(source)).toEqual(["ALPHA_MS", "BETA_LOAD", "DELTA_CHAIN", "EPSILON_MS", "ETA_MS", "GAMMA_MAP", "ZETA_DB"]);
  });
});
