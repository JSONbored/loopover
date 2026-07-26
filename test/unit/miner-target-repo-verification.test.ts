import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  defaultVerificationSpawn,
  killVerificationProcessTree,
  runShellCommandWithTreeKill,
  runTargetRepoVerification,
  VERIFICATION_OUTPUT_TAIL_CHARS,
  type TargetRepoVerificationSpawn,
} from "../../packages/loopover-miner/lib/target-repo-verification.js";
import type { RepoStackResult } from "../../packages/loopover-miner/lib/stack-detection.js";

// #8807: the independent quality gate — the target repo's own commands, never the agent's self-attestation.
function detectedStack(over: Partial<Record<"testCommand" | "lintCommand" | "buildCommand", string | null>> = {}): RepoStackResult {
  return {
    detected: true,
    language: "javascript",
    packageManager: "npm",
    testCommand: "npm test",
    lintCommand: null,
    buildCommand: null,
    formatCommand: null,
    summary: "js",
    ...over,
  } as unknown as RepoStackResult;
}

describe("runTargetRepoVerification (#8807)", () => {
  it("runs detected commands in test → lint → build order from the worktree and passes when all succeed", async () => {
    const calls: Array<{ command: string; cwd: string }> = [];
    const spawn: TargetRepoVerificationSpawn = async (command, options) => {
      calls.push({ command, cwd: options.cwd });
      return { code: 0, output: "ok" };
    };
    const result = await runTargetRepoVerification({
      worktreeDir: "/wt",
      stack: detectedStack({ testCommand: "npm test", lintCommand: "npm run lint", buildCommand: "npm run build" }),
      spawn,
    });
    expect(result.status).toBe("passed");
    expect(calls.map((c) => c.command)).toEqual(["npm test", "npm run lint", "npm run build"]);
    expect(calls.every((c) => c.cwd === "/wt")).toBe(true);
  });

  it("STOPS at the first failure with the failing command, exit code, and a BOUNDED output tail", async () => {
    const spawn: TargetRepoVerificationSpawn = async (command) =>
      command === "npm test" ? { code: 1, output: "x".repeat(VERIFICATION_OUTPUT_TAIL_CHARS * 3) + "FAIL tail" } : { code: 0, output: "ok" };
    const result = await runTargetRepoVerification({
      worktreeDir: "/wt",
      stack: detectedStack({ testCommand: "npm test", lintCommand: "npm run lint" }),
      spawn,
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.firstFailure.command).toBe("npm test");
    expect(result.firstFailure.exitCode).toBe(1);
    expect(result.firstFailure.outputTail.endsWith("FAIL tail")).toBe(true);
    expect(result.firstFailure.outputTail.length).toBeLessThanOrEqual(VERIFICATION_OUTPUT_TAIL_CHARS);
    expect(result.checks).toHaveLength(1); // lint never ran
  });

  it("a timeout-killed command (code null) is a failure, never a silent pass", async () => {
    const spawn: TargetRepoVerificationSpawn = async () => ({ code: null, output: "killed" });
    const result = await runTargetRepoVerification({ worktreeDir: "/wt", stack: detectedStack(), spawn });
    expect(result.status).toBe("failed");
  });

  it("SKIPS (recorded, never a failure) on an undetected stack or a stack with no inferred commands", async () => {
    const spawn = vi.fn();
    const undetected = await runTargetRepoVerification({
      worktreeDir: "/wt",
      stack: { detected: false, reason: "no markers" } as unknown as RepoStackResult,
      spawn: spawn as never,
    });
    expect(undetected).toEqual({ status: "skipped", reason: "stack_undetected" });
    const empty = await runTargetRepoVerification({
      worktreeDir: "/wt",
      stack: detectedStack({ testCommand: null, lintCommand: null, buildCommand: null }),
      spawn: spawn as never,
    });
    expect(empty).toEqual({ status: "skipped", reason: "no_commands_detected" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("the default spawn runs shell commands from the cwd, merges output, and enforces the timeout", async () => {
    const ok = await defaultVerificationSpawn("echo hello && echo err 1>&2", { cwd: process.cwd(), timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS });
    expect(ok.code).toBe(0);
    expect(ok.output).toContain("hello");
    expect(ok.output).toContain("err");
    const fail = await defaultVerificationSpawn("exit 3", { cwd: process.cwd(), timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS });
    expect(fail.code).toBe(3);
    const killed = await defaultVerificationSpawn("sleep 30", { cwd: process.cwd(), timeoutMs: 200 });
    expect(killed.code).not.toBe(0); // SIGKILL → non-zero/null, treated as failure upstream
    // Spawn-level error (nonexistent cwd): resolves code null with the error text — a failure, never a hang.
    const errored = await defaultVerificationSpawn("echo hi", { cwd: "/nonexistent-dir-8807", timeoutMs: 5000 });
    expect(errored.code).toBeNull();
    expect(errored.output).toContain("ENOENT");
  }, 15_000);

  it("uses the default spawn when none is injected (the production arm) — a real fast command passes", async () => {
    const result = await runTargetRepoVerification({
      worktreeDir: process.cwd(),
      stack: detectedStack({ testCommand: "true", lintCommand: null, buildCommand: null }),
    });
    expect(result.status).toBe("passed");
  }, 15_000);

  it("killVerificationProcessTree kills the GROUP via negative pid, falling back to the single-process kill on no-pid or a thrown group kill", () => {
    const groupKills: Array<[number, string]> = [];
    const kill = vi.fn().mockReturnValue(true);
    // Happy arm: pid present → group kill, no single-process fallback.
    killVerificationProcessTree({ pid: 4242, kill }, (pid, signal) => void groupKills.push([pid, signal]));
    expect(groupKills).toEqual([[4242, "SIGKILL"]]);
    expect(kill).not.toHaveBeenCalled();
    // No-pid arm (spawn failed before assigning one) → single-process fallback.
    killVerificationProcessTree({ pid: undefined, kill });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    // Thrown-group-kill arm (group already reaped → ESRCH) → single-process fallback.
    const killAfterThrow = vi.fn().mockReturnValue(true);
    killVerificationProcessTree({ pid: 4242, kill: killAfterThrow }, () => {
      throw new Error("ESRCH");
    });
    expect(killAfterThrow).toHaveBeenCalledWith("SIGKILL");
  });

  it("the bounded settle resolves a timeout even when the kill leaves an orphan holding the pipes (the gate can never hang)", async () => {
    // A no-op killTree simulates a survivor that keeps stdout open past the kill: the settle timer must
    // still resolve the spawn as a timeout failure instead of waiting for the orphan's own exit.
    const result = await runShellCommandWithTreeKill("sleep 1", { cwd: process.cwd(), timeoutMs: 150 }, { killTree: () => undefined, settleMs: 100 });
    expect(result.code).toBeNull();
    expect(result.output).toContain("verification timeout after 150ms");
    // Let the (never-killed) command's own close event fire afterwards: the settled guard must ignore it.
    await new Promise((r) => setTimeout(r, 1100));
  }, 15_000);
});
