import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectSelfHostEnvVars,
  renderSelfHostEnvReferenceMarkdown,
  writeSelfHostEnvReference,
} from "../../scripts/gen-selfhost-env-reference.mjs";

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
    const outputPath = "apps/gittensory-ui/src/lib/selfhost-env-reference.ts";
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
