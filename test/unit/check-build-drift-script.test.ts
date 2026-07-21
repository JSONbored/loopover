import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBuildDrift, pathsForPackage } from "../../scripts/check-build-drift.mjs";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function initScratchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gtbuild-drift-"));
  tmpDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet");
  git("-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init", "--quiet");
  return dir;
}

describe("check-build-drift script", () => {
  describe("pathsForPackage", () => {
    it("resolves the real loopover-miner bin/lib paths", () => {
      expect(pathsForPackage("miner")).toEqual(["packages/loopover-miner/bin", "packages/loopover-miner/lib"]);
    });

    it("resolves the real loopover-mcp bin/lib paths", () => {
      expect(pathsForPackage("mcp")).toEqual(["packages/loopover-mcp/bin", "packages/loopover-mcp/lib"]);
    });

    it("throws a clear error for an unknown package name", () => {
      expect(() => pathsForPackage("engine")).toThrow(/unknown package "engine".*miner.*mcp/s);
    });
  });

  describe("checkBuildDrift (injected run)", () => {
    it("returns empty when the injected git status reports nothing", () => {
      const drift = checkBuildDrift(["packages/loopover-miner/lib"], { run: () => "" });
      expect(drift).toBe("");
    });

    it("trims and returns whatever the injected git status reports", () => {
      const drift = checkBuildDrift(["packages/loopover-miner/lib"], {
        run: () => "\n M packages/loopover-miner/lib/foo.js\n?? packages/loopover-miner/lib/foo.d.ts\n\n",
      });
      expect(drift).toBe("M packages/loopover-miner/lib/foo.js\n?? packages/loopover-miner/lib/foo.d.ts");
    });

    it("passes the paths and cwd it was given through to run", () => {
      const calls: Array<{ paths: string[]; cwd: string }> = [];
      checkBuildDrift(["bin", "lib"], {
        cwd: "/fake/repo",
        run: (paths, cwd) => {
          calls.push({ paths, cwd });
          return "";
        },
      });
      expect(calls).toEqual([{ paths: ["bin", "lib"], cwd: "/fake/repo" }]);
    });
  });

  describe("checkBuildDrift (real git, scratch repo)", () => {
    it("reports clean when nothing has changed since the last commit", () => {
      const dir = initScratchGitRepo();
      expect(checkBuildDrift(["lib"], { cwd: dir })).toBe("");
    });

    it("reports a modified tracked file (the 'stale committed .js' case)", () => {
      const dir = initScratchGitRepo();
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      writeFileSync(join(dir, "foo.js"), "export const x = 1;\n");
      git("add", "foo.js");
      git("-c", "user.email=test@example.com", "-c", "user.name=test", "-c", "commit.gpgsign=false", "commit", "-m", "add foo.js", "--quiet");

      writeFileSync(join(dir, "foo.js"), "export const x = 2;\n");

      expect(checkBuildDrift(["foo.js"], { cwd: dir })).toContain("foo.js");
    });

    it("reports a brand new untracked file (the 'compiled output never committed' case)", () => {
      // git diff --exit-code alone would miss this -- untracked files are invisible to `git diff`,
      // which is exactly why this script uses `git status --porcelain` instead.
      const dir = initScratchGitRepo();
      writeFileSync(join(dir, "bar.d.ts"), "export {};\n");

      const drift = checkBuildDrift(["bar.d.ts"], { cwd: dir });

      expect(drift).toContain("bar.d.ts");
      expect(drift.startsWith("??")).toBe(true);
    });
  });

  describe("CLI (real subprocess)", () => {
    // Most important regression test in this file: proves the REAL currently-committed miner/mcp
    // .js/.d.ts are not already stale relative to their .ts source -- if they were, this check would
    // fail on `main` from the moment it merges. (Doesn't run the build itself -- npm run build:{miner,mcp}
    // already ran as part of getting a green `npm run test:ci` locally before this change was committed.)
    it("reports the real repo's loopover-miner output as clean", () => {
      const output = execFileSync(process.execPath, ["scripts/check-build-drift.mjs", "miner"], { encoding: "utf8" });
      expect(output).toContain("packages/loopover-miner's committed .js/.d.ts matches its .ts source.");
    });

    it("reports the real repo's loopover-mcp output as clean", () => {
      const output = execFileSync(process.execPath, ["scripts/check-build-drift.mjs", "mcp"], { encoding: "utf8" });
      expect(output).toContain("packages/loopover-mcp's committed .js/.d.ts matches its .ts source.");
    });

    it("exits non-zero with a clear message for an unknown package name", () => {
      try {
        execFileSync(process.execPath, ["scripts/check-build-drift.mjs", "engine"], { encoding: "utf8" });
        expect.unreachable("expected the CLI to exit non-zero for an unknown package name");
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        expect(e.status).toBe(1);
        expect(`${e.stdout ?? ""}${e.stderr ?? ""}`).toContain('unknown package "engine"');
      }
    });
  });
});
