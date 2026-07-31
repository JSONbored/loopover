import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

const posthogMock = vi.hoisted(() => {
  const capture = vi.fn();
  const PostHog = vi.fn(function (this: any) {
    this.capture = capture;
    this.flush = vi.fn().mockResolvedValue(undefined);
  });
  return { capture, PostHog };
});
vi.mock("posthog-node", () => ({ PostHog: posthogMock.PostHog }));

import {
  createRealCliSubprocessSpawn,
  constructProductionCodingAgentDriver,
  withCodingAgentAiGenerationCapture,
} from "../../packages/loopover-miner/lib/coding-agent-construction";
import { initMinerPostHog, resetMinerPostHogForTesting } from "../../packages/loopover-miner/lib/posthog";
import type { AgentSdkQueryFn, CodingAgentDriver, CodingAgentDriverTask } from "../../packages/loopover-engine/src/index";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  resetMinerPostHogForTesting();
});

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

  it("REGRESSION: does NOT default-fill house-rule hooks for claude-cli/codex-cli — the default only applies to agent-sdk, the one provider that can enforce them", () => {
    expect(() => constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "claude-cli" })).not.toThrow();
    expect(() => constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "codex-cli" })).not.toThrow();
  });

  it("still fails closed for claude-cli/codex-cli when the caller EXPLICITLY supplies hooks (a real request the engine correctly rejects rather than silently dropping)", () => {
    const explicitHooks = { PreToolUse: [{ hooks: [async () => ({})] }] };
    expect(() =>
      constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "claude-cli" }, { hooks: explicitHooks }),
    ).toThrow(/unsupported_coding_agent_driver_hooks:claude-cli/);
    expect(() =>
      constructProductionCodingAgentDriver({ MINER_CODING_AGENT_PROVIDER: "codex-cli" }, { hooks: explicitHooks }),
    ).toThrow(/unsupported_coding_agent_driver_hooks:codex-cli/);
  });

  it("wires house-rule enforcement into the agent-sdk provider's hooks by default", async () => {
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      // This test exercises hook wiring, not real git enumeration; task.workingDirectory is a fake path, so the
      // real default enumerator would fail closed.
      { query: queryCapturing(captured), listChangedFiles: async () => [] },
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
        listChangedFiles: async () => [],
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

describe("withCodingAgentAiGenerationCapture (#8296 AMS follow-up)", () => {
  function driverReturning(result: Awaited<ReturnType<CodingAgentDriver["run"]>>): CodingAgentDriver {
    return { run: async () => result };
  }

  it("stays a no-op end-to-end when PostHog is unconfigured", async () => {
    const driver = withCodingAgentAiGenerationCapture("claude-cli", "claude-sonnet-5", driverReturning({ ok: true, changedFiles: [], summary: "done", transcript: "" }));
    const result = await driver.run(task);
    expect(result.ok).toBe(true);
    expect(posthogMock.capture).not.toHaveBeenCalled();
  });

  it("forwards the driver's cost, blended tokens AND input/output split to the capture (#10198)", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = withCodingAgentAiGenerationCapture(
      "claude-cli",
      "claude-sonnet-5",
      driverReturning({ ok: true, changedFiles: ["a.ts"], summary: "done", transcript: "", costUsd: 0.12, tokensUsed: 4000, inputTokens: 3200, outputTokens: 800 }),
    );
    await driver.run(task);
    expect(posthogMock.capture).toHaveBeenCalledTimes(1);
    const { properties } = posthogMock.capture.mock.calls[0]?.[0];
    expect(properties.$ai_provider).toBe("claude-cli");
    expect(properties.$ai_model).toBe("claude-sonnet-5");
    expect(properties.$ai_is_error).toBe(false);
    expect(properties.tokens_used).toBe(4000);
    expect(properties.$ai_input_tokens).toBe(3200);
    expect(properties.$ai_output_tokens).toBe(800);
    expect(properties.$ai_total_cost_usd).toBe(0.12);
  });

  it("leaves the split at 0 for a driver that reports only a blended total (#10198)", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = withCodingAgentAiGenerationCapture(
      "codex-cli",
      "gpt-5-codex",
      driverReturning({ ok: true, changedFiles: [], summary: "done", transcript: "", tokensUsed: 4000 }),
    );
    await driver.run(task);
    const { properties } = posthogMock.capture.mock.calls[0]?.[0];
    expect(properties.tokens_used).toBe(4000);
    expect(properties.$ai_input_tokens).toBe(0);
    expect(properties.$ai_output_tokens).toBe(0);
  });

  it("captures result.ok:false as a failure, using the driver's own error string -- no exception thrown", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = withCodingAgentAiGenerationCapture(
      "codex-cli",
      "gpt-5-codex",
      driverReturning({ ok: false, changedFiles: [], summary: "failed", transcript: "", error: "codex_timeout_120000ms" }),
    );
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    const { properties } = posthogMock.capture.mock.calls[0]?.[0];
    expect(properties.$ai_is_error).toBe(true);
    expect(properties.$ai_http_status).toBe(500);
    expect(properties.$ai_error).toBe("codex_timeout_120000ms");
  });

  it("REGRESSION: still captures a failure AND rethrows when the wrapped driver itself throws unexpectedly", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = withCodingAgentAiGenerationCapture("agent-sdk", "agent-sdk", { run: async () => { throw new Error("sdk crashed"); } });
    await expect(driver.run(task)).rejects.toThrow("sdk crashed");
    const { properties } = posthogMock.capture.mock.calls[0]?.[0];
    expect(properties.$ai_is_error).toBe(true);
    expect(properties.$ai_error).toBe("sdk crashed");
  });
});

describe("constructProductionCodingAgentDriver -- $ai_generation capture wiring (#8296 AMS follow-up)", () => {
  it("captures using the configured model env var for a CLI provider", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "claude-cli", MINER_CODING_AGENT_CLAUDE_MODEL: "claude-opus-5" },
      { spawn: async () => ({ stdout: "done", code: 0 }) },
    );
    await driver.run(task);
    const { properties } = posthogMock.capture.mock.calls[0]?.[0];
    expect(properties.$ai_provider).toBe("claude-cli");
    expect(properties.$ai_model).toBe("claude-opus-5");
  });

  it("falls back to the provider name as the model when no model env var is configured (e.g. agent-sdk, which declares none)", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      { query: queryCapturing({}), listChangedFiles: async () => [] },
    );
    await driver.run(task);
    expect(posthogMock.capture.mock.calls[0]?.[0].properties.$ai_model).toBe("agent-sdk");
  });

  it("falls back to the provider name when a CLI provider's own model env var is configured but blank", async () => {
    await initMinerPostHog({ LOOPOVER_MINER_POSTHOG_API_KEY: "phc_test_key" });
    const driver = constructProductionCodingAgentDriver(
      { MINER_CODING_AGENT_PROVIDER: "codex-cli", MINER_CODING_AGENT_CODEX_MODEL: "" },
      { spawn: async () => ({ stdout: "done", code: 0 }) },
    );
    await driver.run(task);
    expect(posthogMock.capture.mock.calls[0]?.[0].properties.$ai_model).toBe("codex-cli");
  });
});
