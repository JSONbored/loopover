import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSdkCodingAgentDriver,
  type AgentSdkQueryFn,
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

test("success: session options, tool-use changed-file tracking, transcript, turn count", async () => {
  const captured: { input?: Parameters<AgentSdkQueryFn>[0] } = {};
  const hooks = { PreToolUse: [{ hooks: ["policy-callback"] }] };
  const driver = createAgentSdkCodingAgentDriver({
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

test("non-success result subtype maps to a structured failure with the subtype as the error", async () => {
  const driver = createAgentSdkCodingAgentDriver({
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
  const driver = createAgentSdkCodingAgentDriver({
    query: queryYielding([
      { type: "result", subtype: "success", is_error: true, num_turns: 1, result: "refused" },
    ]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_errored");
});

test("stream ending without a result frame is a protocol failure, not a silent success", async () => {
  const driver = createAgentSdkCodingAgentDriver({
    query: queryYielding([assistantMessage({ type: "text", text: "started..." })]),
  });
  const result = await driver.run(task);
  assert.equal(result.ok, false);
  assert.equal(result.error, "agent_sdk_no_result");
  assert.ok(result.transcript!.includes("started..."));
});

test("a throw mid-stream returns a redacted structured failure and never propagates", async () => {
  const driver = createAgentSdkCodingAgentDriver({
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
  const driver = createAgentSdkCodingAgentDriver({
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
  const driver = createAgentSdkCodingAgentDriver({
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
  const driver = createAgentSdkCodingAgentDriver({
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
