import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectCrossBoundaryReach, coveredWorkspacesFromDependsOn, findUnhashedReach, parseJsonc } from "../../scripts/check-turbo-typecheck-inputs";

// turbo.json's //#typecheck inputs are a hand-maintained approximation of tsc's real transitive surface. Its
// own comment admits it: "a snapshot ... not a structural guarantee", and asks a human to re-run a grep
// before trusting it. Nobody does, and it HAD drifted — four unhashed paths, one of which invalidated the
// comment's own stated reason for excluding it. This runs that grep every CI instead.

const reach = (path: string) => ({ path, importedBy: "test/unit/x.test.ts" });

describe("findUnhashedReach", () => {
  it("REGRESSION: reports a reached path no glob covers — the real drift this found", () => {
    const unhashed = findUnhashedReach(
      [reach("packages/loopover-mcp/lib"), reach("packages/loopover-miner/lib")],
      ["src/**", "packages/loopover-miner/lib/**"],
      new Set(),
    );
    expect(unhashed.map((entry) => entry.path)).toEqual(["packages/loopover-mcp/lib"]);
  });

  it("a dependsOn build covers its whole workspace — turbo hashes the dependency's own inputs", () => {
    // @loopover/engine#build means the engine's sources are hashed without appearing in this task's inputs.
    // Reporting them would be a false positive that trains people to ignore the check.
    expect(findUnhashedReach([reach("packages/loopover-engine/src")], [], new Set(["packages/loopover-engine"]))).toEqual([]);
  });

  it("a glob matches its own directory and anything under it", () => {
    expect(findUnhashedReach([reach("packages/x/lib")], ["packages/x/lib/**"], new Set())).toEqual([]);
    expect(findUnhashedReach([reach("packages/x/lib")], ["packages/x/**"], new Set())).toEqual([]);
  });

  it("INVARIANT: a NARROWER glob than the reached path still counts as covered", () => {
    // "apps/loopover-ui/src/lib/**" covers a reach recorded as "apps/loopover-ui/src": the hashed set is a
    // subset of the directory, which is what the existing entry means, and flagging it would be noise.
    expect(findUnhashedReach([reach("apps/loopover-ui/src")], ["apps/loopover-ui/src/lib/**"], new Set())).toEqual([]);
  });

  it("no globs and no dependencies reports everything, rather than passing vacuously", () => {
    expect(findUnhashedReach([reach("packages/a/lib"), reach("apps/b/src")], [], new Set())).toHaveLength(2);
  });
});

describe("collectCrossBoundaryReach", () => {
  it("REGRESSION: ignores import statements inside FIXTURE STRINGS by requiring the path to exist", () => {
    // check-import-specifiers-script.test.ts embeds `'import ... from "../packages/engine/lib/..."'` as test
    // DATA. packages/engine was renamed away, so a naive scan reported it as unhashed reach — a false
    // positive that would have been "fixed" by hashing a directory that does not exist.
    const paths = collectCrossBoundaryReach(process.cwd()).map((entry) => entry.path);
    expect(paths).not.toContain("packages/engine/lib");
    expect(paths).not.toContain("packages/engine/src");
    // And it still finds the real ones.
    expect(paths).toContain("packages/loopover-mcp/lib");
  });

  it("REGRESSION (#10046): dynamic import() reaches package.json the same as static from", () => {
    // The old regex required whitespace after `import` before `"`, so `import("...")` never matched.
    // miner-cli.test.ts uses a multi-line dynamic JSON import — pin both forms against a synthetic tree.
    const root = mkdtempSync(join(tmpdir(), "turbo-inputs-10046-"));
    try {
      mkdirSync(join(root, "test", "unit"), { recursive: true });
      mkdirSync(join(root, "packages", "loopover-miner", "lib"), { recursive: true });
      writeFileSync(join(root, "packages", "loopover-miner", "package.json"), '{"name":"@loopover/miner"}\n');
      writeFileSync(join(root, "packages", "loopover-miner", "lib", "version.ts"), "export const v = 1;\n");
      writeFileSync(
        join(root, "test", "unit", "dyn-import.test.ts"),
        [
          'it("dyn", async () => {',
          "  const packageJson = await import(",
          '  "../../packages/loopover-miner/package.json",',
          '  { with: { type: "json" } }',
          ");",
          "});",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "test", "unit", "static-from.test.ts"),
        'import { v } from "../../packages/loopover-miner/lib/version";\nvoid v;\n',
      );

      const reached = collectCrossBoundaryReach(root);
      const paths = reached.map((entry) => entry.path);
      expect(paths).toContain("packages/loopover-miner/package.json");
      expect(paths).toContain("packages/loopover-miner/lib");
      const dyn = reached.find((entry) => entry.path === "packages/loopover-miner/package.json");
      expect(dyn?.importedBy.replace(/\\/g, "/")).toMatch(/test\/unit\/dyn-import\.test\.ts$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("INVARIANT: this repo's own turbo.json covers its real reach", async () => {
    // The check the CI script performs, asserted here too so a `turbo.json` edit that drops a path fails in
    // the test suite as well as the standalone checker.
    const { readFileSync } = await import("node:fs");
    const turbo = parseJsonc(readFileSync("turbo.json", "utf8")) as { tasks: Record<string, { inputs?: string[]; dependsOn?: string[] }> };
    const task = turbo.tasks["//#typecheck"]!;
    const unhashed = findUnhashedReach(
      collectCrossBoundaryReach(process.cwd()),
      task.inputs ?? [],
      coveredWorkspacesFromDependsOn(task.dependsOn ?? [], process.cwd()),
    );
    expect(unhashed.map((entry) => entry.path)).toEqual([]);
  });
});

describe("parseJsonc", () => {
  it("strips line comments and trailing commas so turbo.json parses", () => {
    expect(parseJsonc('{\n  // a comment\n  "a": 1,\n}')).toEqual({ a: 1 });
  });
});
