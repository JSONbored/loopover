import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checksMissingFromWorkflows,
  driftChecksInLocalGate,
  isDriftCheckScript,
  reachableNpmScripts,
} from "../../scripts/check-ci-drift-checks-wired";

// #10269. `npm run test:ci` and .github/workflows/** are two independently hand-maintained lists, and they
// drifted: 22 of 42 local-gate checks ran in NO workflow, so they gated nothing on a repo whose gate
// auto-merges on green CI. The last block pins the real tree, which is the assertion that actually matters.

describe("isDriftCheckScript", () => {
  it("matches the three naming conventions this repo uses for guards", () => {
    expect(isDriftCheckScript("dead-exports:check")).toBe(true);
    expect(isDriftCheckScript("manifest:drift-check")).toBe(true);
    expect(isDriftCheckScript("ui:version-audit")).toBe(true);
  });

  it("does not sweep in build, test or coverage steps", () => {
    // CI runs those through its own jobs; treating them as drift checks would make this unsatisfiable.
    for (const name of ["build:mcp", "test:coverage", "typecheck", "ui:build", "rees:install"]) {
      expect(isDriftCheckScript(name)).toBe(false);
    }
  });

  it("requires the suffix at the END, so a check-shaped prefix does not count", () => {
    expect(isDriftCheckScript("foo:check:extra")).toBe(false);
  });
});

describe("reachableNpmScripts", () => {
  const scripts = {
    "test:ci": "npm run a:check && npm run aggregate",
    aggregate: "npm run b:check",
    "a:check": "node a.ts",
    "b:check": "node b.ts",
    "orphan:check": "node orphan.ts",
  };

  it("follows references transitively, since checks sit behind aggregate scripts", () => {
    const reachable = reachableNpmScripts(scripts, "test:ci");
    expect(reachable.has("a:check")).toBe(true);
    expect(reachable.has("b:check")).toBe(true);
    expect(reachable.has("orphan:check")).toBe(false);
  });

  it("does not follow a --workspace call as a root script", () => {
    // `npm run build --workspace X` targets the workspace's script, not a root one.
    const reachable = reachableNpmScripts({ "test:ci": "npm run build --workspace @loopover/engine", build: "x" }, "test:ci");
    expect(reachable.has("build")).toBe(false);
  });

  it("terminates on a cycle rather than hanging", () => {
    const reachable = reachableNpmScripts({ "test:ci": "npm run a", a: "npm run test:ci" }, "test:ci");
    expect([...reachable].sort()).toEqual(["a", "test:ci"]);
  });

  it("tolerates a reference to a script that does not exist", () => {
    expect(reachableNpmScripts({ "test:ci": "npm run missing:check" }, "test:ci").has("missing:check")).toBe(true);
  });
});

describe("driftChecksInLocalGate", () => {
  it("returns only the checks, sorted, and never the root itself", () => {
    const scripts = { "test:ci": "npm run z:check && npm run a:check && npm run build:mcp", "a:check": "x", "z:check": "x", "build:mcp": "x" };
    expect(driftChecksInLocalGate(scripts)).toEqual(["a:check", "z:check"]);
  });
});

describe("checksMissingFromWorkflows", () => {
  it("treats a check invoked by any workflow as wired", () => {
    expect(checksMissingFromWorkflows(["a:check"], "      - run: npm run a:check\n")).toEqual([]);
  });

  it("reports a check no workflow runs", () => {
    expect(checksMissingFromWorkflows(["a:check"], "      - run: npm run something-else\n")).toEqual(["a:check"]);
  });

  it("REGRESSION: a longer sibling name does not count as wiring the shorter one", () => {
    // Without the word-boundary guard, `npm run foo:check:extra` in a workflow would satisfy `foo:check`
    // by substring match -- silently marking an unwired check as wired, which is this file's whole failure
    // mode rather than a cosmetic bug.
    expect(checksMissingFromWorkflows(["foo:check"], "run: npm run foo:check:extra\n")).toEqual(["foo:check"]);
  });

  it("honours an allowlist entry", () => {
    expect(checksMissingFromWorkflows(["a:check"], "", { "a:check": "reason" })).toEqual([]);
  });

  it("does not treat a bare mention of the name as an invocation", () => {
    // A comment naming the script is not the workflow running it.
    expect(checksMissingFromWorkflows(["a:check"], "# see a:check for details\n")).toEqual(["a:check"]);
  });
});

describe("the real tree satisfies the invariant (#10269)", () => {
  const ciYaml = readFileSync(".github/workflows/ci.yml", "utf8");

  /** One step's own text: from its `- name:` up to the next step at the same indent. */
  function stepText(name: string): string {
    const start = ciYaml.indexOf(`      - name: ${name}\n`);
    expect(start, `step "${name}" not found in ci.yml`).toBeGreaterThan(-1);
    const rest = ciYaml.slice(start + 1);
    const next = rest.indexOf("      - name: ");
    return next === -1 ? rest : rest.slice(0, next);
  }

  /** A step's `if:` condition. */
  function conditionOf(name: string): string {
    return /^ +if: (.+)$/m.exec(stepText(name))![1]!;
  }

  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  const workflowText = readdirSync(".github/workflows")
    .filter((entry) => entry.endsWith(".yml") || entry.endsWith(".yaml"))
    .map((entry) => readFileSync(join(".github/workflows", entry), "utf8"))
    .join("\n");

  it("every drift check the local gate runs is also run by a workflow", () => {
    const missing = checksMissingFromWorkflows(driftChecksInLocalGate(pkg.scripts), workflowText);
    expect(missing).toEqual([]);
  });

  it("the three history-dependent checks run in drift-checks-history, NOT in validate-code", () => {
    // The load-bearing placement. In validate-code's shallow checkout db:migrations:immutable:check fails
    // outright, while release-commit-parsing:check and releasable-commit-types:check both pass VACUOUSLY --
    // green while verifying nothing, which is the exact failure #10269 exists to remove. If someone moves
    // them into the unconditional block, the checks go quietly decorative and this is what catches it.
    const historyJob = ciYaml.slice(ciYaml.indexOf("  drift-checks-history:"), ciYaml.indexOf("  validate-tests:"));
    const block = stepText("Drift checks (unconditional)");

    for (const check of ["db:migrations:immutable:check", "release-commit-parsing:check", "releasable-commit-types:check"]) {
      expect(historyJob).toContain(`npm run ${check}`);
      expect(block).not.toContain(`npm run ${check}`);
    }
    expect(historyJob).toContain("fetch-depth: 0");
    expect(historyJob).toContain("fetch-tags: true");
  });

  it("mcp:tool-reference:check runs AFTER the engine build, carrying that build's exact condition", () => {
    // It resolves a bare `@loopover/engine` specifier through node_modules to dist/, so in the
    // unconditional block -- which runs before "Build engine package" -- it dies with ERR_MODULE_NOT_FOUND.
    // CI caught this; locally it passed only because the worktree happened to have a built engine.
    // The condition is copied from the build VERBATIM: if the two ever diverge, this check silently stops
    // running on the PRs that build the engine, which is the failure mode #10269 is about.
    expect(stepText("Drift checks (unconditional)")).not.toContain("npm run mcp:tool-reference:check");
    expect(conditionOf("MCP tool-reference drift check")).toBe(conditionOf("Build engine package"));
    expect(ciYaml.indexOf("      - name: MCP tool-reference drift check")).toBeGreaterThan(ciYaml.indexOf("      - name: Build engine package"));
  });

  it("the aggregator depends on drift-checks-history, so its failure actually blocks the PR", () => {
    // A job nothing depends on cannot fail a merge -- it would be the same "looks like a gate" problem in a
    // new place.
    const validateJob = ciYaml.slice(ciYaml.indexOf("  validate:\n"));
    expect(validateJob.slice(0, 300)).toContain("drift-checks-history");
  });
});
