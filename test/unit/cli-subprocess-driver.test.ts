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

  it("hands the child a strict non-credential env plus overlaid extras, never the full parent env", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({
      command: "claude",
      spawn,
      parentEnv: {
        HOME: "/home/miner",
        RUNTIME_ONLY_FLAG: "leak-me",
        PATH: "/usr/bin",
        XDG_CONFIG_HOME: "/home/miner/.config",
        XDG_DATA_HOME: "/home/miner/.local/share",
        XDG_STATE_HOME: "/home/miner/.local/state",
      },
      env: { AGENT_SESSION_HANDLE: "provided-by-caller", HOME: "/tmp/isolated-agent-home" },
    });
    await driver.run(TASK);
    const env = calls[0]?.opts.env ?? {};
    expect(env.HOME).toBe("/tmp/isolated-agent-home");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.AGENT_SESSION_HANDLE).toBe("provided-by-caller");
    expect(env.RUNTIME_ONLY_FLAG).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    expect(env.XDG_DATA_HOME).toBeUndefined();
    expect(env.XDG_STATE_HOME).toBeUndefined();
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

  describe("two-tier stalled-output fast-fail timeout (#4994/#5053)", () => {
    it("reports a distinct stalled error when the subprocess produces zero stdout within firstOutputTimeoutMs", async () => {
      const { spawn, calls } = fakeSpawn({ stdout: "", code: null, timedOut: true, stalledNoOutput: true });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn,
        timeoutMs: 120_000,
        firstOutputTimeoutMs: 5000,
      });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("claude_stalled_no_output");
      expect(result.summary).toBe("claude stalled with no stdout within 5000ms");
      expect(calls[0]?.opts.firstOutputTimeoutMs).toBe(5000);
    });

    it("is NOT killed early by the first-output timer when the subprocess produces output before firstOutputTimeoutMs (invariant: live output is never mistaken for a stall)", async () => {
      const { spawn } = fakeSpawn({ stdout: "produced some output then finished", code: 0 });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn, firstOutputTimeoutMs: 1000 });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("claude completed for attempt-1");
    });

    it("preserves the existing full-timeout behavior unchanged when output arrived but the process never exited (#4994/#5053 regression guard)", async () => {
      // stalledNoOutput is absent -- stdout arrived, so only the full timeoutMs governs, same as before this
      // feature existed.
      const { spawn } = fakeSpawn({ stdout: "partial", code: null, timedOut: true });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "codex",
        spawn,
        timeoutMs: 5000,
        firstOutputTimeoutMs: 1000,
      });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("codex_timeout_5000ms");
      expect(result.summary).toBe("codex timed out after 5000ms");
    });

    it("does not forward firstOutputTimeoutMs to spawn when omitted (opt-in, backward compatible)", async () => {
      const { spawn, calls } = fakeSpawn({ stdout: "done", code: 0 });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      await driver.run(TASK);
      expect("firstOutputTimeoutMs" in (calls[0]?.opts ?? {})).toBe(false);
    });

    it("invariant: the driver's result never carries any field beyond the CodingAgentDriverResult contract (no attempt/governor state)", async () => {
      const { spawn } = fakeSpawn({ stdout: "", code: null, timedOut: true, stalledNoOutput: true });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn, firstOutputTimeoutMs: 500 });
      const result = await driver.run(TASK);
      expect(Object.keys(result).sort()).toEqual(["changedFiles", "error", "ok", "summary", "transcript"]);
    });
  });
});
