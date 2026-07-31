import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSdkCodingAgentDriver,
  type AgentSdkQueryFn,
  type CreateAgentSdkDriverOptions,
  type CodingAgentDriverTask,
} from "../dist/index.js";

// Secret-shaped strings are BUILT AT RUNTIME so the diff never contains a token-shaped literal (the
// repo secret scanner pattern-matches raw diff text; redactSecrets only needs the shape to exist at runtime).
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

test("success: session options, tool-use changed-file tracking, transcript, turn count", async () => {
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

  assert.equal(result.ok, true);
  // File-edit tools are deduped; a Bash tool call is not a changed file.
  assert.deepEqual(result.changedFiles, ["src/a.ts", "docs/b.md"]);
  assert.equal(result.turnsUsed, 4);
  assert.equal(result.summary, "Fixed the bug.");
  assert.ok(result.transcript!.includes("editing now"));
  assert.ok(result.transcript!.includes("Fixed the bug."));

  // The prompt is the composed instructions verbatim; the session is scoped to the attempt's worktree with the
  // task's turn budget, edit-capable permission mode, and the caller's hooks forwarded untouched (#2343).
  assert.equal(captured.input!.prompt, task.instructions);
  assert.equal(captured.input!.options.cwd, task.workingDirectory);
  assert.equal(captured.input!.options.maxTurns, 6);
  assert.equal(captured.input!.options.permissionMode, "acceptEdits");
  assert.equal(captured.input!.options.hooks, hooks);
});

test("success derives changed files from the worktree after untracked mutating tools", async () => {
  const driver = driverWith({
    query: queryYielding([
      assistantMessage({ type: "tool_use", name: "Bash", input: { command: "node mutate.js" } }),
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "mutated" },
    ]),
    listChangedFiles: async (cwd) => {
      assert.equal(cwd, task.workingDirectory);
      return ["packages/loopover-engine/src/vulnerable.ts"];
    },
  });

  const result = await driver.run(task);

  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFiles, ["packages/loopover-engine/src/vulnerable.ts"]);
});

test("success fails closed when changed-file enumeration is unavailable, but still reports the real dollar cost", async () => {
  const driver = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", total_cost_usd: 0.0042 },
    ]),
    listChangedFiles: async () => {
      throw new Error("not a git worktree");
    },
  });

  const result = await driver.run(task);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changedFiles, []);
  assert.match(result.error!, /agent_sdk_changed_files_unavailable: not a git worktree/);
  // The SDK session ran and was billed before enumeration ever failed -- budgetSpent must not silently
  // undercount this path just because the changed-files step failed afterward.
  assert.equal(result.costUsd, 0.0042);
});

test("success reports real input+output tokens from the SDK's own usage field (#5653)", async () => {
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

  assert.equal(result.ok, true);
  assert.equal(result.tokensUsed, 1234);
});

test("failure (non-success subtype) still reports real tokens -- the session was billed either way, same as costUsd", async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.tokensUsed, 600);
});

test("tokensUsed is undefined (never a fabricated 0) when the result message carries no usage field at all", async () => {
  const driver = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done" },
    ]),
  });

  const result = await driver.run(task);

  assert.equal(result.ok, true);
  assert.equal(result.tokensUsed, undefined);
});

test("tokensUsed is undefined when usage exists but is malformed (not an object, or non-numeric fields)", async () => {
  const malformedUsage = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: "not-an-object" },
    ]),
  });
  const malformedResult = await malformedUsage.run(task);
  assert.equal(malformedResult.tokensUsed, undefined);

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
  const nonNumericResult = await nonNumericFields.run(task);
  assert.equal(nonNumericResult.tokensUsed, undefined);
});

// #5827: a malformed num_turns/total_cost_usd (negative, NaN, Infinity) must degrade to undefined — the same
// finite/non-negative discipline cli-subprocess-driver.ts applies — so it never reaches accumulateAttemptUsage
// (attempt-metering.ts), which throws a RangeError on such input and would reject the whole iterate loop.
test("turnsUsed degrades to undefined for a negative, NaN, or Infinity num_turns (#5827)", async () => {
  for (const badTurns of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const driver = driverWith({
      query: queryYielding([{ type: "result", subtype: "success", is_error: false, num_turns: badTurns, result: "done" }]),
    });
    const result = await driver.run(task);
    assert.equal(result.turnsUsed, undefined, `num_turns=${String(badTurns)} should degrade to undefined`);
  }
});

test("costUsd degrades to undefined for a negative, NaN, or Infinity total_cost_usd (#5827)", async () => {
  for (const badCost of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const driver = driverWith({
      query: queryYielding([{ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", total_cost_usd: badCost }]),
    });
    const result = await driver.run(task);
    assert.equal(result.costUsd, undefined, `total_cost_usd=${String(badCost)} should degrade to undefined`);
  }
});

test("tokensUsed ignores a negative/NaN/Infinity usage field instead of poisoning the sum (#5827)", async () => {
  // output_tokens is out-of-contract (negative); input_tokens is valid — the sum uses only the valid field.
  const partiallyBad = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: 100, output_tokens: -5 } },
    ]),
  });
  assert.equal((await partiallyBad.run(task)).tokensUsed, 100);

  // Both fields out-of-contract → undefined (never a fabricated 0 or a NaN/Infinity sum).
  const allBad = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: Number.NaN, output_tokens: Number.POSITIVE_INFINITY } },
    ]),
  });
  assert.equal((await allBad.run(task)).tokensUsed, undefined);
});

test("tokensUsed sums whichever of input/output tokens IS a real number, when only input is present", async () => {
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

  assert.equal(result.tokensUsed, 42);
});

test("tokensUsed sums whichever of input/output tokens IS a real number, when only output is present", async () => {
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

  assert.equal(result.tokensUsed, 17);
});

test("success stringifies a non-Error changed-file enumeration failure", async () => {
  const driver = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done" },
    ]),
    listChangedFiles: async () => {
      throw "git unavailable";
    },
  });

  const result = await driver.run(task);

  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_changed_files_unavailable: git unavailable");
});

test("non-success result subtype maps to a structured failure with the subtype as the error", async () => {
  const driver = driverWith({
    query: queryYielding([
      assistantMessage({ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }),
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 6 },
    ]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_error_max_turns");
  assert.equal(result.turnsUsed, 6);
  // Parity with the CLI-subprocess driver: no changed-file claims on a failed attempt.
  assert.deepEqual(result.changedFiles, []);
});

test("a success-subtype result that still flags is_error is treated as a failure", async () => {
  const driver = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: true, num_turns: 1, result: "refused" },
    ]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_errored");
});

test("stream ending without a result frame is a protocol failure, not a silent success", async () => {
  const driver = driverWith({
    query: queryYielding([assistantMessage({ type: "text", text: "started..." })]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_no_result");
  assert.ok(result.transcript!.includes("started..."));
});

test("a throw mid-stream returns a redacted structured failure and never propagates", async () => {
  const driver = driverWith({
    query: () =>
      (async function* (): AsyncGenerator<Record<string, unknown>> {
        yield assistantMessage({ type: "text", text: "before the crash" });
        throw new Error(`bridge died: token ${fakeApiKey} leaked`);
      })(),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.match(result.error!, /^agent_sdk_thrown: bridge died/);
  assert.ok(!result.error!.includes(fakeApiKey));
  assert.match(result.error!, /\[redacted\]/);
  assert.ok(result.transcript!.includes("before the crash"));
});

test("secret shapes in the result text are redacted from summary and transcript", async () => {
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
  assert.equal(result.ok, true);
  assert.ok(!result.summary.includes(fakeGithubToken));
  assert.match(result.summary, /\[redacted\]/);
  assert.ok(!result.transcript!.includes(fakeGithubToken));
});

test("malformed frames (no content array, non-object blocks, missing file_path) are skipped defensively", async () => {
  const driver = driverWith({
    query: queryYielding([
      { type: "assistant" },
      { type: "assistant", message: { content: "not-an-array" } },
      assistantMessage("not-an-object" as unknown as Record<string, unknown>, {
        type: "tool_use",
        name: "Edit",
        input: { no_file_path: true },
      }),
      { type: "status" },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "" },
    ]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changedFiles, []);
  // Empty result text falls back to the count summary.
  assert.match(result.summary, /0 changed file\(s\)/);
});

test("names a result frame with no usable subtype 'unknown'", async () => {
  const driver = driverWith({
    query: queryYielding([{ type: "result", is_error: true }]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_unknown");
  assert.equal(result.turnsUsed, undefined);
});

test("constructs with no options, defaulting to the real SDK query loop without invoking it", () => {
  const driver = createAgentSdkCodingAgentDriver();
  assert.equal(typeof driver.run, "function");
});

// #10198: the driver used to sum input/output tokens and DISCARD the two sides. The miner's PostHog capture
// therefore had nothing to put in `$ai_input_tokens`/`$ai_output_tokens` -- the properties PostHog's own cost
// views read -- so every miner generation registered there as 0 input and 0 output tokens.
test("reports the input/output split alongside the blended total (#10198)", async () => {
  const driver = driverWith({
    query: queryYielding([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        result: "done",
        usage: { input_tokens: 1000, output_tokens: 234 },
      },
    ]),
  });

  const result = await driver.run(task);

  assert.equal(result.tokensUsed, 1234);
  assert.equal(result.inputTokens, 1000);
  assert.equal(result.outputTokens, 234);
});

test("the split rides the failure results too, exactly like tokensUsed and costUsd (#10198)", async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.inputTokens, 500);
  assert.equal(result.outputTokens, 100);
});

test("a side the provider did not report stays ABSENT rather than being zeroed (#10198)", async () => {
  // A fabricated 0 is indistinguishable from a real 0 once aggregated, so an out-of-contract or missing side
  // must not become one -- the blended total still counts only what was real.
  const onlyInput = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: 100 } },
    ]),
  });
  const onlyInputResult = await onlyInput.run(task);
  assert.equal(onlyInputResult.tokensUsed, 100);
  assert.equal(onlyInputResult.inputTokens, 100);
  assert.equal(onlyInputResult.outputTokens, undefined);

  const badOutput = driverWith({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", usage: { input_tokens: 100, output_tokens: -5 } },
    ]),
  });
  const badOutputResult = await badOutput.run(task);
  assert.equal(badOutputResult.tokensUsed, 100);
  assert.equal(badOutputResult.outputTokens, undefined);

  const noUsage = driverWith({
    query: queryYielding([{ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done" }]),
  });
  const noUsageResult = await noUsage.run(task);
  assert.equal(noUsageResult.tokensUsed, undefined);
  assert.equal(noUsageResult.inputTokens, undefined);
  assert.equal(noUsageResult.outputTokens, undefined);
});
