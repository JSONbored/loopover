import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import {
  createAgentSdkCodingAgentDriver,
  type AgentSdkQueryFn,
  type CreateAgentSdkDriverOptions,
  type CodingAgentDriverTask,
} from "../../packages/loopover-engine/src/index";

// Secret-shaped strings are BUILT AT RUNTIME so the diff never contains a token-shaped literal (the
// repo secret scanner pattern-matches raw diff text; redactSecrets only needs the shape to exist at runtime).
const execFileAsync = promisify(execFile);

const fakeApiKey = ["sk", "abcdefghijklmnop1234"].join("-");
const fakeGithubToken = ["ghp", "abcdefghijklmnopqrst123456"].join("_");

const task: CodingAgentDriverTask = {
  attemptId: "attempt-3",
  workingDirectory: "/tmp/worktrees/attempt-3",
  acceptanceCriteriaPath: "/tmp/worktrees/attempt-3/ACCEPTANCE-CRITERIA.md",
  instructions: "Apply the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 6,
};

function assistantMessage(...content: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: "assistant", message: { content } };
}

function queryYielding(
  messages: Array<Record<string, unknown>>,
  captured?: { input?: Parameters<AgentSdkQueryFn>[0] },
): AgentSdkQueryFn {
  return (input) => {
    if (captured) captured.input = input;
    return (async function* () {
      yield* messages;
    })();
  };
}

function driverWith(options: CreateAgentSdkDriverOptions) {
  return createAgentSdkCodingAgentDriver({ listChangedFiles: async () => [], ...options });
}

describe("createAgentSdkCodingAgentDriver", () => {
  it("maps a successful session: options, hook pass-through, changed-file tracking, turn count", async () => {
    const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
    const hooks = { PreToolUse: [{ hooks: ["policy-callback"] }] };
    const driver = driverWith({
      query: queryYielding(
        [
          assistantMessage({ type: "text", text: "editing now" }),
          assistantMessage(
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Write", input: { file_path: "docs/b.md" } },
            { type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          ),
          { type: "result", subtype: "success", is_error: false, num_turns: 4, result: "Fixed the bug." },
        ],
        captured,
      ),
      hooks,
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(true);
    // File-edit tools are deduped; a Bash tool call is not a changed file.
    expect(result.changedFiles).toEqual(["src/a.ts", "docs/b.md"]);
    expect(result.turnsUsed).toBe(4);
    expect(result.summary).toBe("Fixed the bug.");
    expect(result.transcript).toContain("editing now");
    expect(result.transcript).toContain("Fixed the bug.");

    // The prompt is the composed instructions verbatim; the session is scoped to the attempt's worktree with
    // the task's turn budget, edit-capable permission mode, and the caller's hooks forwarded untouched (#2343).
    expect(captured.input!.prompt).toBe(task.instructions);
    expect(captured.input!.options.cwd).toBe(task.workingDirectory);
    expect(captured.input!.options.maxTurns).toBe(6);
    expect(captured.input!.options.permissionMode).toBe("acceptEdits");
    // Read + Bash are explicitly allowlisted (#7245): acceptEdits alone auto-approves only file EDITs, so a
    // headless task that must explore the repo and run tests would otherwise have every Read/Bash call denied.
    expect(captured.input!.options.allowedTools).toEqual(["Read", "Bash"]);
    expect(captured.input!.options.hooks).toBe(hooks);
  });

  it("enumerates tracked and untracked worktree changes with git", async () => {
    // Real subprocess spawns (init, add, commit, plus the driver's own diff enumeration) -- legitimately
    // more wall-clock latency than the default 15s test timeout reliably covers under concurrent CI
    // shard/system load (passes in well under 1s in isolation). Commit identity goes through
    // GIT_AUTHOR_*/GIT_COMMITTER_* env vars on the commit call instead of two separate `git config`
    // subprocess spawns, cutting setup from 5 sequential git invocations to 3 -- but each remaining spawn
    // still waits on real OS process-scheduling under load, which a smaller loop-body trim can reduce but
    // not eliminate. Reproduced under simulated contention (16 CPU-bound processes oversubscribing a
    // 12-core machine): clean single-attempt runs ranged ~0.3-20s, with one run exceeding 30s outright.
    // 60s covers the observed range with headroom instead of relying on ambient timing.
    const dir = await mkdtemp(join(tmpdir(), "loopover-agent-sdk-"));
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    try {
      await execFileAsync("git", ["init"], { cwd: dir });
      await writeFile(join(dir, "tracked.ts"), "export const value = 1;\n");
      await execFileAsync("git", ["add", "tracked.ts"], { cwd: dir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir, env: commitEnv });

      const driver = createAgentSdkCodingAgentDriver({
        query: queryYielding([
          assistantMessage({ type: "tool_use", name: "Bash", input: { command: "node mutate.js" } }),
          { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "mutated" },
        ]),
      });

      await writeFile(join(dir, "tracked.ts"), "export const value = 2;\n");
      await writeFile(join(dir, "untracked.ts"), "export const fresh = true;\n");

      const result = await driver.run({ ...task, workingDirectory: dir });

      expect(result.ok).toBe(true);
      expect(result.changedFiles).toEqual(["tracked.ts", "untracked.ts"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("derives changed files from the worktree after untracked mutating tools", async () => {
    const driver = driverWith({
      query: queryYielding([
        assistantMessage({ type: "tool_use", name: "Bash", input: { command: "node mutate.js" } }),
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "mutated" },
      ]),
      listChangedFiles: async (cwd) => {
        expect(cwd).toBe(task.workingDirectory);
        return ["packages/loopover-engine/src/vulnerable.ts"];
      },
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual(["packages/loopover-engine/src/vulnerable.ts"]);
  });

  it("fails closed when changed-file enumeration is unavailable, but still reports the real dollar cost", async () => {
    const driver = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", total_cost_usd: 0.0042 },
      ]),
      listChangedFiles: async () => {
        throw new Error("not a git worktree");
      },
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.error).toContain("agent_sdk_changed_files_unavailable: not a git worktree");
    // The SDK session ran and was billed before enumeration ever failed -- budgetSpent must not silently
    // undercount this path just because the changed-files step failed afterward.
    expect(result.costUsd).toBe(0.0042);
  });

  it("reports real input+output tokens from the SDK's own usage field (#5653)", async () => {
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 3,
          result: "done",
          total_cost_usd: 0.01,
          usage: { input_tokens: 1000, output_tokens: 234 },
        },
      ]),
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(true);
    expect(result.tokensUsed).toBe(1234);
  });

  it("counts the prompt-cache tiers as input tokens (#10246)", async () => {
    // Matches the ORB side's totalInputTokens (#10251) so both parsers report the same thing for the same
    // envelope -- the two are deliberately parallel copies and must not diverge on arithmetic.
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: "done",
          usage: { input_tokens: 2, output_tokens: 787, cache_read_input_tokens: 48210, cache_creation_input_tokens: 1536 },
        },
      ]),
    });

    const result = await driver.run(task);

    expect(result.inputTokens).toBe(49748);
    expect(result.outputTokens).toBe(787);
    expect(result.tokensUsed).toBe(50535);
  });

  it("keeps a genuinely-zero tier, and reports no input at all as undefined (#10246)", async () => {
    const cacheOnly = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 0, cache_read_input_tokens: 900 } },
      ]),
    });
    expect((await cacheOnly.run(task)).inputTokens).toBe(900);

    const outputOnly = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { output_tokens: 50 } },
      ]),
    });
    expect((await outputOnly.run(task)).inputTokens).toBeUndefined();
  });

  it("still reports real tokens on a non-success subtype -- the session was billed either way, same as costUsd", async () => {
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 6,
          total_cost_usd: 0.05,
          usage: { input_tokens: 500, output_tokens: 100 },
        },
      ]),
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(false);
    expect(result.tokensUsed).toBe(600);
  });

  it("tokensUsed is undefined (never a fabricated 0) when the result message carries no usage field at all", async () => {
    const driver = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done" },
      ]),
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(true);
    expect(result.tokensUsed).toBeUndefined();
  });

  it("tokensUsed is undefined when usage exists but is malformed (not an object, or non-numeric fields)", async () => {
    const malformedUsage = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: "not-an-object" },
      ]),
    });
    expect((await malformedUsage.run(task)).tokensUsed).toBeUndefined();

    const nonNumericFields = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: "done",
          usage: { input_tokens: "a lot", output_tokens: null },
        },
      ]),
    });
    expect((await nonNumericFields.run(task)).tokensUsed).toBeUndefined();
  });

  // #5827: a malformed num_turns/total_cost_usd (negative, NaN, Infinity) must degrade to undefined — the same
  // finite/non-negative discipline cli-subprocess-driver.ts applies — so it never reaches accumulateAttemptUsage,
  // which throws a RangeError on such input and would reject the whole iterate loop before its decision is logged.
  it("turnsUsed degrades to undefined for a negative, NaN, or Infinity num_turns (#5827)", async () => {
    for (const badTurns of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const driver = driverWith({
        query: queryYielding([{ type: "result", subtype: "success", is_error: false, num_turns: badTurns, result: "done" }]),
      });
      expect((await driver.run(task)).turnsUsed).toBeUndefined();
    }
  });

  it("costUsd degrades to undefined for a negative, NaN, or Infinity total_cost_usd (#5827)", async () => {
    for (const badCost of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const driver = driverWith({
        query: queryYielding([{ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", total_cost_usd: badCost }]),
      });
      expect((await driver.run(task)).costUsd).toBeUndefined();
    }
  });

  it("tokensUsed ignores a negative/NaN/Infinity usage field instead of poisoning the sum (#5827)", async () => {
    const partiallyBad = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: 100, output_tokens: -5 } },
      ]),
    });
    expect((await partiallyBad.run(task)).tokensUsed).toBe(100);

    const allBad = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: Number.NaN, output_tokens: Number.POSITIVE_INFINITY } },
      ]),
    });
    expect((await allBad.run(task)).tokensUsed).toBeUndefined();
  });

  it("tokensUsed sums whichever of input/output tokens IS a real number, when only input is present", async () => {
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: "done",
          usage: { input_tokens: 42 },
        },
      ]),
    });

    const result = await driver.run(task);

    expect(result.tokensUsed).toBe(42);
  });

  it("tokensUsed sums whichever of input/output tokens IS a real number, when only output is present", async () => {
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: "done",
          usage: { output_tokens: 17 },
        },
      ]),
    });

    const result = await driver.run(task);

    expect(result.tokensUsed).toBe(17);
  });

  it("stringifies a non-Error changed-file enumeration failure", async () => {
    const driver = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done" },
      ]),
      listChangedFiles: async () => {
        throw "git unavailable";
      },
    });

    const result = await driver.run(task);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_changed_files_unavailable: git unavailable");
  });

  it("maps a non-success result subtype to a structured failure named by the subtype", async () => {
    const driver = driverWith({
      query: queryYielding([
        assistantMessage({ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }),
        { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 6 },
      ]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_error_max_turns");
    expect(result.turnsUsed).toBe(6);
    // Parity with the CLI-subprocess driver: no changed-file claims on a failed attempt.
    expect(result.changedFiles).toEqual([]);
  });

  it("treats a success-subtype result that still flags is_error as a failure", async () => {
    const driver = driverWith({
      query: queryYielding([
        { type: "result", subtype: "success", is_error: true, num_turns: 1, result: "refused" },
      ]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_errored");
  });

  it("names a result frame with no usable subtype 'unknown'", async () => {
    const driver = driverWith({
      query: queryYielding([{ type: "result", is_error: true }]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_unknown");
    expect(result.turnsUsed).toBeUndefined();
  });

  it("treats a stream that ends without a result frame as a protocol failure", async () => {
    const driver = driverWith({
      query: queryYielding([assistantMessage({ type: "text", text: "started..." })]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_no_result");
    expect(result.transcript).toContain("started...");
  });

  it("returns a redacted structured failure when the stream throws an Error", async () => {
    const driver = driverWith({
      query: () =>
        (async function* (): AsyncGenerator<Record<string, unknown>> {
          yield assistantMessage({ type: "text", text: "before the crash" });
          throw new Error(`bridge died: token ${fakeApiKey} leaked`);
        })(),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^agent_sdk_thrown: bridge died/);
    expect(result.error).not.toContain(fakeApiKey);
    expect(result.error).toContain("[redacted]");
    expect(result.transcript).toContain("before the crash");
  });

  it("stringifies a non-Error throw instead of crashing", async () => {
    const driver = driverWith({
      query: () =>
        (async function* (): AsyncGenerator<Record<string, unknown>> {
          throw "bridge exited 137";
        })(),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("agent_sdk_thrown: bridge exited 137");
  });

  it("redacts secret shapes from the summary and transcript", async () => {
    const driver = driverWith({
      query: queryYielding([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 2,
          result: `done, but echoed ${fakeGithubToken}`,
        },
      ]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(true);
    expect(result.summary).not.toContain(fakeGithubToken);
    expect(result.summary).toContain("[redacted]");
    expect(result.transcript).not.toContain(fakeGithubToken);
  });

  it("skips malformed frames defensively and falls back to the count summary on empty result text", async () => {
    const driver = driverWith({
      query: queryYielding([
        { type: "assistant" },
        { type: "assistant", message: { content: "not-an-array" } },
        assistantMessage("not-an-object" as unknown as Record<string, unknown>, {
          type: "tool_use",
          name: "Edit",
          input: { no_file_path: true },
        }),
        assistantMessage({ type: "tool_use", input: { file_path: "nameless.ts" } }),
        { type: "status" },
        { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "" },
      ]),
    });
    const result = await driver.run(task);
    expect(result.ok).toBe(true);
    expect(result.changedFiles).toEqual([]);
    // Empty result text falls back to the count summary.
    expect(result.summary).toMatch(/0 changed file\(s\)/);
  });

  it("constructs with no options, defaulting to the real SDK query loop without invoking it", () => {
    const driver = createAgentSdkCodingAgentDriver();
    expect(typeof driver.run).toBe("function");
  });
});
