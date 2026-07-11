import { describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { buildHouseRulesAgentSdkHooks, runHouseRulesEnforcedCodingAgentAttempt } from "../../packages/gittensory-miner/lib/coding-agent-house-rules.js";
import type { AgentSdkQueryFn, CodingAgentDriverTask } from "@jsonbored/gittensory-engine";

// buildHouseRulesPreToolUseHook's own deny-rule matching logic (matcher, glob, path-tokenizing, force-push
// detection) is already exhaustively tested in miner-pretooluse-hook.test.ts. These tests cover only this
// module's own job: wrapping that hook into the SDK's registration shape, and defaulting `hooks` for
// runCodingAgentAttempt's `agent-sdk` provider without overriding a caller-supplied value.

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

/** A fake AgentSdkQueryFn that captures its own call input (mirrors agent-sdk-driver.test.ts's own helper),
 *  so a test can assert on exactly what `hooks` shape reached the SDK session. */
function queryCapturing(captured: { input?: Parameters<AgentSdkQueryFn>[0] }): AgentSdkQueryFn {
  return (input) => {
    captured.input = input;
    return (async function* () {
      yield assistantResult();
    })();
  };
}

describe("buildHouseRulesAgentSdkHooks (#2343 follow-up)", () => {
  it("wraps the house-rules hook in the SDK's documented PreToolUse matcher-group shape", () => {
    const hooks = buildHouseRulesAgentSdkHooks();
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]!.hooks).toHaveLength(1);
    expect(typeof hooks.PreToolUse[0]!.hooks[0]).toBe("function");
  });

  it("the wrapped callback actually enforces the house-rule denylist (not just a matching shape)", async () => {
    const hooks = buildHouseRulesAgentSdkHooks();
    const callback = hooks.PreToolUse[0]!.hooks[0]!;
    const denied = await callback({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const allowed = await callback({ tool_name: "Read", tool_input: { file_path: "src/index.ts" } });
    expect(allowed).toEqual({});
  });

  it("threads config.repoFullName and options.append through to the underlying hook", async () => {
    const append = vi.fn();
    const hooks = buildHouseRulesAgentSdkHooks({ repoFullName: "acme/widgets" }, { append });
    const callback = hooks.PreToolUse[0]!.hooks[0]!;
    await callback({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "acme/widgets" }));
  });
});

describe("runHouseRulesEnforcedCodingAgentAttempt (#2343 follow-up)", () => {
  it("defaults hooks to house-rules enforcement for the agent-sdk provider when the caller omits it", async () => {
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const result = await runHouseRulesEnforcedCodingAgentAttempt({
      providerName: "agent-sdk",
      task,
      query: queryCapturing(captured),
    });

    expect(result.mode).toBe("live");
    expect(result.result.ok).toBe(true);
    const hooks = captured.input!.options.hooks as ReturnType<typeof buildHouseRulesAgentSdkHooks>;
    expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
    // Prove it's a REAL, enforcing hook, not an empty placeholder shape.
    const callback = hooks.PreToolUse[0]!.hooks[0]!;
    const denied = await callback({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("does NOT override a caller-supplied hooks option", async () => {
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const callerHooks = { PreToolUse: [{ hooks: ["caller-supplied-marker"] }] };
    await runHouseRulesEnforcedCodingAgentAttempt({
      providerName: "agent-sdk",
      task,
      query: queryCapturing(captured),
      hooks: callerHooks,
    });

    expect(captured.input!.options.hooks).toBe(callerHooks);
  });

  it("threads houseRulesConfig/houseRulesOptions into the defaulted hook without leaking them to the driver factory", async () => {
    const append = vi.fn();
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    await runHouseRulesEnforcedCodingAgentAttempt({
      providerName: "agent-sdk",
      task,
      query: queryCapturing(captured),
      houseRulesConfig: { repoFullName: "acme/widgets" },
      houseRulesOptions: { append },
    });

    const hooks = captured.input!.options.hooks as ReturnType<typeof buildHouseRulesAgentSdkHooks>;
    await hooks.PreToolUse[0]!.hooks[0]!({ tool_name: "Read", tool_input: { file_path: ".env" } });
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ repoFullName: "acme/widgets" }));
  });

  it("is inert (no error) for a provider that ignores hooks entirely", async () => {
    const result = await runHouseRulesEnforcedCodingAgentAttempt({ providerName: "noop", task });
    expect(result.result.ok).toBe(true);
  });

  it("a paused/dry-run attempt never constructs a driver, so hooks default harmlessly without ever being consulted", async () => {
    const result = await runHouseRulesEnforcedCodingAgentAttempt({
      providerName: "agent-sdk",
      task,
      agentPaused: true,
    });
    expect(result.mode).toBe("paused");
  });
});
