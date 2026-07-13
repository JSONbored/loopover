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
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "Fix the pagination bug.",
    ]);
  });

  it("uses codex's own real default argv (the exec subcommand, not claude's flags)", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "done", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(true);
    expect(calls[0]?.cmd).toBe("codex");
    expect(calls[0]?.args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "Fix the pagination bug."]);
  });

  it("fails closed at construction time for an unrecognized command with no explicit buildArgs override", () => {
    const { spawn } = fakeSpawn({ stdout: "", code: 0 });
    expect(() => createCliSubprocessCodingAgentDriver({ command: "some-other-cli", spawn })).toThrow(
      "unsupported_cli_subprocess_command:some-other-cli",
    );
  });

  it("an explicit buildArgs override still works for an unrecognized command (the fail-closed default is bypassable on purpose)", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "done", code: 0 });
    const driver = createCliSubprocessCodingAgentDriver({ command: "some-other-cli", spawn, buildArgs: () => ["--custom"] });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(true);
    expect(calls[0]?.args).toEqual(["--custom"]);
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

  describe("Claude Code JSON error-envelope diagnostics (#5168)", () => {
    it("folds a valid {is_error, api_error_status} envelope into a precise claude_code_error_<status>", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ is_error: true, api_error_status: "invalid_api_key" }),
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("claude_code_error_invalid_api_key");
    });

    it("falls back to subtype when api_error_status is absent, and to 'unknown' when both are absent", async () => {
      const { spawn: spawnSubtype } = fakeSpawn({
        stdout: JSON.stringify({ is_error: true, subtype: "overloaded" }),
        code: 1,
      });
      const driverSubtype = createCliSubprocessCodingAgentDriver({ command: "claude", spawn: spawnSubtype });
      expect((await driverSubtype.run(TASK)).error).toBe("claude_code_error_overloaded");

      const { spawn: spawnUnknown } = fakeSpawn({ stdout: JSON.stringify({ is_error: true }), code: 1 });
      const driverUnknown = createCliSubprocessCodingAgentDriver({ command: "claude", spawn: spawnUnknown });
      expect((await driverUnknown.run(TASK)).error).toBe("claude_code_error_unknown");
    });

    it("falls back to the raw stderr-slice shape unchanged when stdout has no error envelope (regression: today's uninformative-error behavior is preserved for the non-envelope case)", async () => {
      const { spawn } = fakeSpawn({ stdout: "not json at all", code: 1, stderr: "generic failure" });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("claude_exit_1: generic failure");
    });

    it("falls back unchanged when stdout is valid JSON but is_error is not true", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ is_error: false, result: "partial answer" }),
        code: 1,
        stderr: "exit detail",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("claude_exit_1: exit detail");
    });

    it("never inspects the envelope for a non-claude command (falls through to the generic exit-code error untouched)", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ is_error: true, api_error_status: "invalid_api_key" }),
        code: 1,
        stderr: "codex own error text",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_exit_1: codex own error text");
    });

    it("invariant: a folded envelope error is never left unredacted when it happens to contain a known secret value", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ is_error: true, api_error_status: "token-my-injected-longkey-leaked" }),
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn,
        knownSecrets: ["my-injected-longkey-leaked"],
      });
      const result = await driver.run(TASK);
      expect(result.error).not.toContain("my-injected-longkey-leaked");
      expect(result.error).toContain("[redacted]");
    });
  });

  describe("Codex JSONL stdout error diagnostics (#5169)", () => {
    it("prefers a real error object found in JSONL stdout over the generic exit-code error", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"type":"start"}\n{"error":"unknown model: gpt-9"}',
        code: 1,
        stderr: "Reading prompt from stdin...",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("codex_exit_1: unknown model: gpt-9");
    });

    it("scans lines in reverse and returns the LAST detail-bearing line, skipping malformed/non-JSON lines in between", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"message":"stale first error"}\nnot json at all\n\n{"msg":"the real final error"}',
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_exit_1: the real final error");
    });

    it("falls through past a falsy (empty-string) error field to the next detail field", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ error: "", message: "the real message" }),
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_exit_1: the real message");
    });

    it("extracts the detail from a nested error.message object shape", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ error: { message: "rate limited" } }),
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_exit_1: rate limited");
    });

    it("resolves to a 'run codex auth' remediation when stdout has no detail and stderr is only the stdin-reading banner", async () => {
      const { spawn } = fakeSpawn({
        stdout: "",
        code: 1,
        stderr: "Reading prompt from stdin...",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_no_auth: auth.json missing or expired -- run `codex auth` to authenticate");
    });

    it("regression: falls back to the generic stderr-based error unchanged when stdout has nothing parseable and stderr is NOT the exact auth banner", async () => {
      const { spawn } = fakeSpawn({
        stdout: "not json at all",
        code: 1,
        stderr: "some other stderr detail",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("codex_exit_1: some other stderr detail");
    });

    it("never scans stdout for JSONL errors on a non-codex command (falls through untouched even with codex-shaped stdout)", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"error":"unknown model: gpt-9"}',
        code: 1,
        stderr: "claude own stderr",
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.error).toBe("claude_exit_1: claude own stderr");
    });

    it("invariant: a folded JSONL-detail error is never left unredacted when it contains a known secret value", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ error: "auth failed for token my-injected-longkey-leaked" }),
        code: 1,
      });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "codex",
        spawn,
        knownSecrets: ["my-injected-longkey-leaked"],
      });
      const result = await driver.run(TASK);
      expect(result.error).not.toContain("my-injected-longkey-leaked");
      expect(result.error).toContain("[redacted]");
    });
  });

  describe("REGRESSION: claude exits 0 while still reporting an error envelope (#5135 follow-up)", () => {
    it("reports ok:false when --output-format json's envelope carries is_error:true even on exit code 0", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: "invalid_api_key", total_cost_usd: 0 }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("claude_code_error_invalid_api_key");
    });

    it("still reports ok:true on a genuine exit-0 success envelope with is_error:false", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.02 }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
    });

    it("never inspects the envelope for a non-claude command on exit 0 either", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ is_error: true, api_error_status: "invalid_api_key" }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
    });
  });

  describe("REGRESSION: real dollar-cost extraction (#5135 follow-up)", () => {
    it("extracts claude's real total_cost_usd from its single JSON result on success", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.1234 }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.costUsd).toBe(0.1234);
    });

    it("extracts codex's real cost from its JSONL event stream, tolerating either key spelling", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"type":"start"}\n{"type":"turn","total_cost_usd":0.05}\n{"type":"end"}',
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.costUsd).toBe(0.05);
    });

    it("stays undefined (never fabricated) when stdout carries no cost field at all", async () => {
      const { spawn } = fakeSpawn({ stdout: "plain text output, no JSON", code: 0 });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.costUsd).toBeUndefined();
    });

    it("takes the largest cost value seen across a multi-event codex stream (cumulative, matches src/selfhost/ai.ts's own convention)", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"total_cost_usd":0.01}\n{"total_cost_usd":0.07}\n{"total_cost_usd":0.03}',
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.costUsd).toBe(0.07);
    });

    it("ignores a non-numeric cost field value instead of throwing or fabricating a number", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ total_cost_usd: "not-a-number" }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.costUsd).toBeUndefined();
    });

    it("ignores a negative cost value (a real number, but not a valid cost) instead of surfacing it", async () => {
      const { spawn } = fakeSpawn({
        stdout: JSON.stringify({ total_cost_usd: -1 }),
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "claude", spawn });
      const result = await driver.run(TASK);
      expect(result.costUsd).toBeUndefined();
    });

    it("ignores a JSONL line that parses to a non-object (array or primitive) instead of throwing", async () => {
      const { spawn } = fakeSpawn({
        stdout: '[1,2,3]\n"just a string"\n{"total_cost_usd":0.09}',
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.costUsd).toBe(0.09);
    });

    it("skips a blank interior line in the JSONL stream rather than treating it as malformed JSON", async () => {
      const { spawn } = fakeSpawn({
        stdout: '{"total_cost_usd":0.06}\n\n{"type":"end"}',
        code: 0,
      });
      const driver = createCliSubprocessCodingAgentDriver({ command: "codex", spawn });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.costUsd).toBe(0.06);
    });
  });

  describe("two-tier stalled-output timeout regression (#5196 — guards the #4994/#5053 CLI-stall outage)", () => {
    it("surfaces a distinct 'stalled' error (not a full timeout) when the CLI emits zero stdout past firstOutputTimeoutMs", async () => {
      // #4994/#5053: a claude/codex process that produced NO output was killed only at the full timeoutMs, masking
      // the stall as a generic timeout. The fast-fail first-output deadline must report it distinctly instead.
      const { spawn } = fakeSpawn({ stdout: "", code: null, timedOut: true, stalledNoOutput: true });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn,
        timeoutMs: 120_000,
        firstOutputTimeoutMs: 5_000,
      });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("claude_stalled_no_output");
      expect(result.summary).toBe("claude stalled with no stdout within 5000ms");
      // Distinctness guard: a stall must never be conflated with the generic full-timeout error.
      expect(result.error).not.toContain("_timeout_");
    });

    it("does NOT kill a slow-but-producing run: output before firstOutputTimeoutMs clears the stall timer and it completes normally", async () => {
      // A run that emits at least one byte before the first-output deadline is healthy — a real spawn clears the
      // first-output timer on that byte, so `stalledNoOutput` is never set and the driver returns success.
      const { spawn } = fakeSpawn({ stdout: "warming up... done", code: 0 });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn,
        timeoutMs: 120_000,
        firstOutputTimeoutMs: 5_000,
      });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(true);
      expect(result.transcript).toBe("warming up... done");
    });

    it("preserves the pre-existing full-timeout path unchanged when output was produced but the process never exits (regression guard)", async () => {
      // Once output has cleared the stall timer, a process that runs past the full timeoutMs must still yield the
      // generic `_timeout_` error — the new fast-fail path must not alter the old full-timeout behavior.
      const { spawn } = fakeSpawn({ stdout: "partial output, still working", code: null, timedOut: true });
      const driver = createCliSubprocessCodingAgentDriver({
        command: "claude",
        spawn,
        timeoutMs: 5_000,
        firstOutputTimeoutMs: 1_000,
      });
      const result = await driver.run(TASK);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("claude_timeout_5000ms");
      expect(result.error).not.toContain("stalled");
    });
  });
});
