import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { danglingScriptReferences, listCheckerScripts, npmScriptsInvoking, reachableNpmScripts, resolveCheckerHome } from "../../scripts/check-checkers-wired";

describe("danglingScriptReferences (#9860)", () => {
  it("catches a test:ci step naming a script that does not exist", () => {
    // The real find: test:ci called `npm run publishable-deps:check`, nothing defined it, so the documented
    // one-command local gate died with "Missing script" -- and the checker behind it had never once run.
    const scripts = { "test:ci": "npm run lint && npm run publishable-deps:check", lint: "eslint ." };
    expect(danglingScriptReferences(scripts, "test:ci")).toEqual(["publishable-deps:check"]);
  });

  it("does not flag a --workspace invocation, which resolves against the workspace", () => {
    // `npm run build --workspace @loopover/engine` is valid with no root `build` script; reading it as a root
    // reference would report three phantom failures on the real package.json.
    const scripts = { "test:ci": "npm run build --workspace @loopover/engine && npm run build --workspace=@loopover/ui" };
    expect(danglingScriptReferences(scripts, "test:ci")).toEqual([]);
  });

  it("is empty for a fully-defined chain, and for a root that does not exist", () => {
    expect(danglingScriptReferences({ "test:ci": "npm run lint", lint: "eslint ." }, "test:ci")).toEqual([]);
    expect(danglingScriptReferences({}, "test:ci")).toEqual([]);
  });
});

describe("reachableNpmScripts", () => {
  it("follows references transitively", () => {
    const scripts = { "test:ci": "npm run a", a: "npm run b", b: "tsx scripts/check-b.ts" };
    expect([...reachableNpmScripts(scripts, "test:ci")].sort()).toEqual(["a", "b", "test:ci"]);
  });

  it("counts npm lifecycle hooks, which run without being referenced anywhere", () => {
    // A checker wired as `pretest` is wired: npm runs it around `test` and no `npm run` ever names it.
    const scripts = { "test:ci": "npm run test", test: "vitest", pretest: "tsx scripts/check-node-version.ts" };
    expect(reachableNpmScripts(scripts, "test:ci").has("pretest")).toBe(true);
  });

  it("does not follow a --workspace call into a nonexistent root script", () => {
    const scripts = { "test:ci": "npm run build --workspace @loopover/engine" };
    expect(reachableNpmScripts(scripts, "test:ci").has("build")).toBe(false);
  });

  it("terminates on a cycle rather than looping forever", () => {
    const scripts = { "test:ci": "npm run a", a: "npm run b", b: "npm run a" };
    expect([...reachableNpmScripts(scripts, "test:ci")].sort()).toEqual(["a", "b", "test:ci"]);
  });
});

describe("resolveCheckerHome", () => {
  const base = { scripts: {}, reachableFromTestCi: new Set<string>(), workflowText: "", otherScriptSources: [], allowed: {} };

  it("finds a checker wired into the local gate", () => {
    const home = resolveCheckerHome({
      ...base,
      file: "check-foo.ts",
      scripts: { "foo:check": "tsx scripts/check-foo.ts" },
      reachableFromTestCi: new Set(["foo:check"]),
    });
    expect(home).toEqual({ kind: "test-ci", via: "npm run foo:check" });
  });

  it("finds one whose home is a workflow — by npm script name, or by the file itself", () => {
    const viaScript = resolveCheckerHome({ ...base, file: "check-foo.ts", scripts: { "foo:check": "tsx scripts/check-foo.ts" }, workflowText: "run: npm run foo:check" });
    expect(viaScript.kind).toBe("workflow");
    // A workflow that shells the file directly, with no npm script at all, still counts.
    const viaFile = resolveCheckerHome({ ...base, file: "check-foo.ts", workflowText: "run: npx tsx scripts/check-foo.ts" });
    expect(viaFile.kind).toBe("workflow");
  });

  it("treats a checker imported by a sibling script as a shared module, not an entry point", () => {
    // Assembled at runtime rather than written as a literal: `check-import-specifiers.ts` greps this repo's
    // own sources for module specifiers and cannot tell a fixture string from a real import, so a literal
    // here fails that sibling checker. The value under test is identical either way.
    const importLine = `import { x } from "./${"check-foo-core"}.ts";`;
    const home = resolveCheckerHome({ ...base, file: "check-foo-core.ts", otherScriptSources: [importLine] });
    expect(home.kind).toBe("imported");
  });

  it("accepts an explicit allowlist entry, carrying its reason", () => {
    const home = resolveCheckerHome({ ...base, file: "check-foo.ts", allowed: { "check-foo.ts": "release-time only" } });
    expect(home).toEqual({ kind: "allowed", via: "release-time only" });
  });

  it("reports a checker that runs NOWHERE", () => {
    // The whole point: a correct, reviewed checker that is wired into nothing guards nothing, while its
    // presence in the tree reads as coverage.
    expect(resolveCheckerHome({ ...base, file: "check-orphan.ts" }).kind).toBe("none");
  });
});

describe("the real repository", () => {
  it("every scripts/check-*.ts entry point has a home", () => {
    // Runs the actual resolution over the real tree, so this suite fails the same way the CI checker does
    // rather than only exercising hand-written fixtures.
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const entries = readdirSync("scripts");
    const reachable = reachableNpmScripts(pkg.scripts, "test:ci");
    const workflowText = readdirSync(".github/workflows")
      .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
      .map((entry) => readFileSync(`.github/workflows/${entry}`, "utf8"))
      .join("\n");

    const homeless = listCheckerScripts(entries).filter((file) => {
      const otherScriptSources = entries.filter((entry) => entry.endsWith(".ts") && entry !== file).map((entry) => readFileSync(`scripts/${entry}`, "utf8"));
      return resolveCheckerHome({ file, scripts: pkg.scripts, reachableFromTestCi: reachable, workflowText, otherScriptSources }).kind === "none";
    });
    expect(homeless).toEqual([]);
  });

  it("test:ci references no script that does not exist", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(danglingScriptReferences(pkg.scripts, "test:ci")).toEqual([]);
  });

  it("guards against a vacuous sweep: the repo really does have checkers to check", () => {
    expect(listCheckerScripts(readdirSync("scripts")).length).toBeGreaterThan(20);
    expect(npmScriptsInvoking(JSON.parse(readFileSync("package.json", "utf8")).scripts, "check-dead-exports.ts")).toContain("dead-exports:check");
  });
});
