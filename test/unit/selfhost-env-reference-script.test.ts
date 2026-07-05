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
      "",
    ].join("\n"),
  );
  return root;
}

describe("gen-selfhost-env-reference (#2081)", () => {
  it("extracts static env reads and keeps the first source reference", () => {
    expect(collectSelfHostEnvVars({ rootDir: fixtureRoot() })).toEqual([
      { name: "ALIASED_ENV", firstReference: "src/selfhost/a.ts:5" },
      { name: "BRACKET_ONLY", firstReference: "src/selfhost/a.ts:4" },
      { name: "CASTED_ONLY", firstReference: "src/services/notify-discord.ts:3" },
      { name: "CTX_ONLY", firstReference: "src/selfhost/a.ts:10" },
      { name: "DEFAULTED_ENV", firstReference: "src/selfhost/a.ts:5" },
      { name: "DESTRUCTURED", firstReference: "src/selfhost/a.ts:5" },
      { name: "FIRST", firstReference: "src/selfhost/a.ts:3" },
      { name: "HELPER_ONLY", firstReference: "src/selfhost/a.ts:6" },
      { name: "NESTED_ONLY", firstReference: "src/selfhost/nested/b.ts:2" },
      { name: "OBJECT_ALIASED", firstReference: "src/selfhost/a.ts:9" },
      { name: "OBJECT_BRACKET", firstReference: "src/selfhost/a.ts:8" },
      { name: "OBJECT_DESTRUCTURED", firstReference: "src/selfhost/a.ts:9" },
      { name: "PARSED_INT_ONLY", firstReference: "src/services/notify-discord.ts:4" },
      { name: "SECOND", firstReference: "src/selfhost/a.ts:2" },
      { name: "SERVER_ONLY", firstReference: "src/server.ts:1" },
      { name: "SERVICE_HELPER_ONLY", firstReference: "src/services/notify-discord.ts:2" },
      { name: "SERVICE_ONLY", firstReference: "src/services/notify-discord.ts:1" },
    ]);
  });

  it("scans configured JavaScript roots and rejects file-shaped directories", () => {
    const root = fixtureRoot();

    expect(
      collectSelfHostEnvVars({
        rootDir: root,
        sourceRoots: ["scripts/selfhost-smoke.mjs"],
      }),
    ).toEqual([{ name: "SCRIPT_ONLY", firstReference: "scripts/selfhost-smoke.mjs:1" }]);

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
        { name: "FIRST", firstReference: "src/selfhost/a.ts:3" },
        { name: "SECOND", firstReference: "src/selfhost/a.ts:2" },
      ]),
    ).toBe(
      [
        "| Name | First reference |",
        "| --- | --- |",
        "| `FIRST` | `src/selfhost/a.ts:3` |",
        "| `SECOND` | `src/selfhost/a.ts:2` |",
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
    expect(generated).toContain("src/selfhost/a.ts:3");

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
