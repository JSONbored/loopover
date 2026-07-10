import { describe, expect, it } from "vitest";
import {
  createCliSubprocessCodingAgentDriver,
  type CliSubprocessSpawnFn,
} from "../../packages/gittensory-engine/src/index";
import type { CodingAgentDriverTask } from "../../packages/gittensory-engine/src/index";

const TASK: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/work/attempt-1",
  acceptanceCriteriaPath: "/work/attempt-1/acceptance-criteria.json",
  instructions: "Fix the pagination bug.",
  maxTurns: 6,
};

/** A fake spawn that records the call and returns a scripted result. */
function fakeSpawn(result: Awaited<ReturnType<CliSubprocessSpawnFn>>) {
  const calls: Array<{ cmd: string; args: readonly string[]; opts: Parameters<CliSubprocessSpawnFn>[2] }> = [];
  const spawn: CliSubprocessSpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return result;
  };
  return { spawn, calls };
}

describe("createCliSubprocessCodingAgentDriver (#4266)", () => {
  it("returns ok on exit 0 and spawns in the task's working directory with the default argv", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "done", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("claude completed for attempt-1");
    expect(result.transcript).toBe("done");
    expect(result.changedFiles).toEqual([]);
    expect(calls[0]?.cmd).toBe("claude");
    expect(calls[0]?.opts.cwd).toBe("/work/attempt-1");
    expect(calls[0]?.opts.timeoutMs).toBe(120_000);
    expect(calls[0]?.args).toEqual([
      "--max-turns",
      "6",
      "--acceptance-criteria",
      "/work/attempt-1/acceptance-criteria.json",
      "Fix the pagination bug.",
    ]);
  });

  it("returns a redacted error on a non-zero exit code", async () => {
    const { spawn } = fakeSpawn({
      stdout: "",
      code: 1,
      stderr: "auth failed for token sk-ant-abcdefghijklmnop12345",
    });
    const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("codex exited non-zero");
    expect(result.error).toContain("codex_exit_1:");
    expect(result.error).toContain("auth failed");
    expect(result.error).toContain("[redacted]");
    expect(result.error).not.toContain("sk-ant-abcdefghijklmnop12345");
  });

  it("falls back to 'exit <code>' when a failing subprocess wrote no stderr (incl. a null code)", async () => {
    const { spawn } = fakeSpawn({ stdout: "", code: null });
    const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("claude_exit_null: exit null");
  });

  it("reports a timeout distinctly from a non-zero exit", async () => {
    const { spawn } = fakeSpawn({ stdout: "partial", code: null, timedOut: true });
    const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn, timeoutMs: 5000 });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("claude timed out after 5000ms");
    expect(result.error).toBe("claude_timeout_5000ms");
  });

  it("hands the child a strict allowlisted env plus overlaid extras, never the full parent env", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({
      command: "claude",
      spawn,
      parentEnv: { HOME: "/home/miner", RUNTIME_ONLY_FLAG: "leak-me", PATH: "/usr/bin" },
      env: { AGENT_SESSION_HANDLE: "provided-by-caller" },
    });
    await driver.run(TASK);
    const env = calls[0]?.opts.env ?? {};
    expect(env.HOME).toBe("/home/miner");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.AGENT_SESSION_HANDLE).toBe("provided-by-caller");
    expect(env.RUNTIME_ONLY_FLAG).toBeUndefined();
  });

  it("redacts known secret values and honors a custom argv builder", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "used my-injected-longkey to auth", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({
      command: "claude",
      spawn,
      knownSecrets: ["my-injected-longkey"],
      buildArgs: (task) => ["run", task.attemptId],
    });
    const result = await driver.run(TASK);
    expect(result.transcript).toBe("used [redacted] to auth");
    expect(calls[0]?.args).toEqual(["run", "attempt-1"]);
  });
});
