import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// buildAgentAttemptSeam lazy-imports "@loopover/engine"; point that at the workspace source so the dynamic
// import resolves under vitest (same shim the sibling full-execution test uses).
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { parseCrossRepoEvaluationManifest } from "../../packages/loopover-miner/lib/cross-repo-evaluation.js";
import {
  buildAgentAttemptSeam,
  parseCrossRepoEvaluationArgs,
  resetRepo,
  runFullCrossRepoExecutionCli,
  spawnRepoCommand,
} from "../../packages/loopover-miner/scripts/cross-repo-evaluation.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("cross-repo full-execution CLI seams (#7634)", () => {
  describe("parseCrossRepoEvaluationArgs", () => {
    it("sets fullExecution:true for --full-execution", () => {
      const a = parseCrossRepoEvaluationArgs(["--full-execution"]);
      expect("fullExecution" in a && a.fullExecution).toBe(true);
    });

    it("leaves fullExecution:false for an empty argv", () => {
      const a = parseCrossRepoEvaluationArgs([]);
      expect("fullExecution" in a && a.fullExecution).toBe(false);
    });
  });

  describe("runFullCrossRepoExecutionCli", () => {
    it("drives the full-execution loop through injected fakes without touching real subprocesses/agent", async () => {
      const parsed = parseCrossRepoEvaluationManifest(
        JSON.stringify({ repos: [{ repoFullName: "acme/widgets", fixturePath: "/fake" }] }),
      );
      const { parsed: outParsed, results, summary } = await runFullCrossRepoExecutionCli({
        parsed,
        existsSync: () => true,
        detectRepoStack: () => ({ detected: true, testCommand: "npm test", buildCommand: null }),
        resolveMinerGoalSpec: () => ({ present: true }),
        buildCodingTaskSpec: () => ({ ready: true, instructions: "x" }),
        // Injecting these three means the default real seams (buildAgentAttemptSeam / spawnRepoCommand) are NOT used.
        runAgentAttempt: async () => ({ diff: "real" }),
        buildRepo: async () => ({ ok: true }),
        runRepoTests: async () => ({ ok: true }),
      } as any);
      expect(outParsed).toBe(parsed);
      expect(results).toHaveLength(1);
      expect(results[0]?.repoFullName).toBe("acme/widgets");
      expect(results[0]?.passed).toBe(true);
      expect(summary.passed).toBe(1);
    });
  });

  describe("spawnRepoCommand", () => {
    it("returns ok:true for a command that exits 0", () => {
      const result = spawnRepoCommand({ repoPath: process.cwd(), command: "node --version" });
      expect(result.ok).toBe(true);
    });

    it("returns ok:false with a detail for a non-zero exit", () => {
      const result = spawnRepoCommand({ repoPath: process.cwd(), command: "node -e process.exit(3)" });
      expect(result.ok).toBe(false);
      expect(result.detail).toBeTruthy();
    });

    it("returns {ok:false, detail:'empty command'} for a blank command", () => {
      expect(spawnRepoCommand({ repoPath: process.cwd(), command: "" })).toEqual({ ok: false, detail: "empty command" });
    });
  });

  describe("resetRepo", () => {
    function git(cwd: string, args: string[]) {
      try {
        execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        throw new Error(`git ${args.join(" ")} failed: ${(error as Error).message}`);
      }
    }

    it("reverts tracked modifications and removes untracked files", () => {
      const dir = mkdtempSync(join(tmpdir(), "loopover-reset-repo-"));
      tempDirs.push(dir);
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test"]);
      const tracked = join(dir, "tracked.txt");
      writeFileSync(tracked, "original\n", "utf8");
      git(dir, ["add", "tracked.txt"]);
      git(dir, ["commit", "-m", "init"]);

      // Dirty the clone: modify a tracked file and add an untracked one.
      writeFileSync(tracked, "modified\n", "utf8");
      const untracked = join(dir, "untracked.txt");
      writeFileSync(untracked, "junk\n", "utf8");

      resetRepo(dir);

      // Line-ending tolerant: git's autocrlf may rewrite LF->CRLF on Windows checkout. The point is that the
      // tracked file is reverted to its committed content and the untracked file is gone.
      expect(readFileSync(tracked, "utf8").replace(/\r/g, "")).toBe("original\n");
      expect(() => readFileSync(untracked, "utf8")).toThrow();
    });
  });

  describe("buildAgentAttemptSeam", () => {
    it("returns a runner that rejects when no coding-agent provider is configured", async () => {
      const runAgentAttempt = await buildAgentAttemptSeam({} as NodeJS.ProcessEnv);
      expect(typeof runAgentAttempt).toBe("function");
      await expect(
        runAgentAttempt({
          repoFullName: "a/b",
          repoPath: "/x",
          stack: { detected: true, testCommand: "t", buildCommand: null },
        }),
      ).rejects.toThrow(/no coding-agent provider/);
    });
  });
});
