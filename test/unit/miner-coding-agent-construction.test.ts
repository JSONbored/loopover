import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { createRealCliSubprocessSpawn, constructProductionCodingAgentDriver } from "../../packages/gittensory-miner/lib/coding-agent-construction.js";
import type { AgentSdkQueryFn, CodingAgentDriverTask } from "../../packages/gittensory-engine/src/index";

const task: CodingAgentDriverTask = {
  attemptId: "attempt-1",
  workingDirectory: "/tmp/worktrees/attempt-1",
  acceptanceCriteriaPath: "/tmp/worktrees/attempt-1/ACCEPTANCE-CRITERIA.md",
  instructions: "Apply the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 4,
};

function assistantResult(): Record<string, unknown> {
  return { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done" };
}

function queryCapturing(captured: { input?: Parameters<AgentSdkQueryFn>[0] }): AgentSdkQueryFn {
  return (input) => {
    captured.input = input;
    return (async function* () {
      yield assistantResult();
    })();
  };
}

describe("createRealCliSubprocessSpawn (#5131)", () => {
  it("captures stdout and a zero exit code from a real short-lived process", async () => {
    const spawnFn = createRealCliSubprocessSpawn();
    const result = await spawnFn(process.execPath, ["-e", "process.stdout.write('hello')"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result).toEqual({ stdout: "hello", code: 0, stderr: "" });
  });

  it("captures stderr and a non-zero exit code", async () => {
    const spawnFn = createRealCliSubprocessSpawn();
    const result = await spawnFn(process.execPath, ["-e", "process.stderr.write('oops'); process.exit(2)"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toBe("oops");
  });

  it("resolves (never rejects) with code:null and the error message on stderr when the command doesn't exist", async () => {
    const spawnFn = createRealCliSubprocessSpawn();
    const result = await spawnFn("this-command-definitely-does-not-exist-xyz", [], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
    });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain("this-command-definitely-does-not-exist-xyz");
  });

  it("kills a long-lived process and resolves with timedOut:true when the caller-supplied timeout elapses", async () => {
    const spawnFn = createRealCliSubprocessSpawn();
    const result = await spawnFn(process.execPath, ["-e", "setInterval(() => {}, 50)"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });
});

describe("constructProductionCodingAgentDriver (#5131)", () => {
  it("fails closed (throws) when MINER_CODING_AGENT_PROVIDER is unset", () => {
    expect(() => constructProductionCodingAgentDriver({})).toThrow(/unconfigured_coding_agent_driver/);
  });

  it("fails closed when every configured name is unknown (deny-by-default)", () => {
    expect(() => constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "bogus" })).toThrow(
      /unconfigured_coding_agent_driver/,
    );
  });

  it("resolves the FIRST configured name from a comma-separated list, skipping unknown entries", async () => {
    const driver = constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "bogus,noop" });
    const result = await driver.run(task);
    expect(result.ok).toBe(true);
  });

  it("constructs a real, working driver for the noop provider (no spawn required)", async () => {
    const driver = constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "noop" });
    const result = await driver.run(task);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual([]);
  });

  it("constructs a claude-cli driver wired to an injected spawn, without invoking it during construction", async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
      {
        spawn: async (cmd, args) => {
          calls.push({ cmd, args });
          return { stdout: "done", code: 0 };
        },
      },
    );
    expect(calls).toHaveLength(0); // construction alone must not spawn anything
    const result = await driver.run(task);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("claude");
    expect(result.ok).toBe(true);
  });

  it("defaults to a real (non-injected) spawn for a CLI provider when the caller supplies none", () => {
    // Construction alone must succeed without ever invoking the real spawn (a real "claude" binary is not
    // present in CI) — proving the `options.spawn ?? createRealCliSubprocessSpawn()` default branch is taken.
    const driver = constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "claude-cli" });
    expect(typeof driver.run).toBe("function");
  });

  it("wires house-rule enforcement into the agent-sdk provider's hooks by default", async () => {
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      { query: queryCapturing(captured) },
    );
    const result = await driver.run(task);
    expect(result.ok).toBe(true);

    const hooks = captured.input!.options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    // Prove it's a REAL, enforcing hook, not an empty placeholder shape.
    const callback = hooks.PreToolUse[0]!.hooks[0]!;
    const denied = await callback({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("threads houseRulesConfig/houseRulesOptions into the defaulted hook", async () => {
    const append = vi.fn();
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      {
        query: queryCapturing(captured),
        houseRulesConfig: { repoFullName: "acme/widgets" },
        houseRulesOptions: { append },
      },
    );
    await driver.run(task);

    const hooks = captured.input!.options.hooks as { PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> };
    await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "acme/widgets" }));
  });
});
