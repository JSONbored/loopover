import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createCodingAgentDriver,
  emitMinerAiGeneration,
  hasMinerAiGenerationSink,
  resolveCodingAgentTelemetryModel,
  runChatGrounding,
  runCodingAgentAttempt,
  setMinerAiGenerationSink,
  withCodingAgentGenerationCapture,
  CHAT_GROUNDING_PROVIDER,
  type ChatGroundingEvent,
  type ChatQueryFn,
  type CodingAgentDriverTask,
  type MinerAiGenerationRecord,
} from "../dist/index.js";

// Engine-side behavior suite for the host-registered $ai_generation sink (#10200). Mirrored by
// test/unit/miner-ai-generation-sink.test.ts in the app's vitest run; both are needed because the two coverage
// uploads are unioned per line and only this one actually behavior-tests the engine package.

const task: CodingAgentDriverTask = {
  attemptId: "attempt-sink-1",
  workingDirectory: "/tmp/worktrees/attempt-sink-1",
  acceptanceCriteriaPath: "/tmp/worktrees/attempt-sink-1/ACCEPTANCE-CRITERIA.md",
  instructions: "Apply the fix described in ACCEPTANCE-CRITERIA.md.",
  maxTurns: 4,
};

function recordingSink(): MinerAiGenerationRecord[] {
  const records: MinerAiGenerationRecord[] = [];
  setMinerAiGenerationSink((record) => records.push(record));
  return records;
}

afterEach(() => {
  setMinerAiGenerationSink(undefined);
});

test("emitMinerAiGeneration is a no-op with no sink, and forwards once one is registered", () => {
  assert.equal(hasMinerAiGenerationSink(), false);
  emitMinerAiGeneration({ provider: "agent-sdk", model: "agent-sdk", latencyMs: 1, isError: false });
  const records = recordingSink();
  assert.equal(hasMinerAiGenerationSink(), true);
  emitMinerAiGeneration({ provider: "claude-cli", model: "claude-sonnet-5", latencyMs: 7, isError: false });
  assert.equal(records.length, 1);
  setMinerAiGenerationSink(undefined);
  emitMinerAiGeneration({ provider: "claude-cli", model: "claude-sonnet-5", latencyMs: 7, isError: false });
  assert.equal(records.length, 1);
});

test("a throwing sink never reaches the caller it is instrumenting", () => {
  setMinerAiGenerationSink(() => {
    throw new Error("posthog exploded");
  });
  assert.doesNotThrow(() => emitMinerAiGeneration({ provider: "agent-sdk", model: "agent-sdk", latencyMs: 1, isError: true }));
});

test("resolveCodingAgentTelemetryModel reads the configured model env var, else the provider name", () => {
  assert.equal(resolveCodingAgentTelemetryModel("claude-cli", { MINER_CODING_AGENT_CLAUDE_MODEL: "claude-opus-5" }), "claude-opus-5");
  assert.equal(resolveCodingAgentTelemetryModel("agent-sdk", {}), "agent-sdk");
  assert.equal(resolveCodingAgentTelemetryModel("codex-cli", { MINER_CODING_AGENT_CODEX_MODEL: "  " }), "codex-cli");
});

test("REGRESSION: runCodingAgentAttempt's own driver path is captured (#10200's named bypass)", async () => {
  const records = recordingSink();
  await runCodingAgentAttempt({
    providerName: "claude-cli",
    env: { MINER_CODING_AGENT_MODE: "live", MINER_CODING_AGENT_CLAUDE_MODEL: "claude-opus-5" },
    task,
    spawn: async () => ({ stdout: "done", code: 0 }),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.provider, "claude-cli");
  assert.equal(records[0]?.model, "claude-opus-5");
  assert.equal(records[0]?.isError, false);
});

test("noop and injected drivers are NOT captured -- neither reaches a model", async () => {
  const records = recordingSink();
  await createCodingAgentDriver({ providerName: "noop", env: {} }).run(task);
  const injected = {
    run: async (_task: CodingAgentDriverTask) => ({ ok: true as const, changedFiles: [], summary: "injected", transcript: "" }),
  };
  assert.equal(createCodingAgentDriver({ providerName: "claude-cli", driver: injected }), injected);
  await injected.run(task);
  assert.equal(records.length, 0);
});

test("withCodingAgentGenerationCapture omits unreported usage and carries the driver's own error", async () => {
  const records = recordingSink();
  await withCodingAgentGenerationCapture("codex-cli", "gpt-5-codex", {
    run: async () => ({ ok: true as const, changedFiles: [], summary: "done", transcript: "" }),
  }).run(task);
  assert.equal(records[0]?.inputTokens, undefined);
  assert.equal(records[0]?.outputTokens, undefined);
  assert.equal(records[0]?.totalCostUsd, undefined);

  await withCodingAgentGenerationCapture("codex-cli", "gpt-5-codex", {
    run: async () => ({ ok: false as const, changedFiles: [], summary: "failed", transcript: "", error: "codex_timeout_120000ms" }),
  }).run(task);
  assert.equal(records[1]?.isError, true);
  assert.equal(records[1]?.error, "codex_timeout_120000ms");
});

test("withCodingAgentGenerationCapture captures and rethrows a driver exception", async () => {
  const records = recordingSink();
  const driver = withCodingAgentGenerationCapture("agent-sdk", "agent-sdk", {
    run: async () => {
      throw new Error("sdk crashed");
    },
  });
  await assert.rejects(() => driver.run(task), /sdk crashed/);
  assert.equal(records[0]?.isError, true);
});

const USER_ONLY = [{ role: "user" as const, content: "what is my run state?" }];

function queryYielding(messages: Array<Record<string, unknown>>): ChatQueryFn {
  return () =>
    (async function* () {
      yield* messages;
    })();
}

async function collect(events: AsyncIterable<ChatGroundingEvent>): Promise<ChatGroundingEvent[]> {
  const out: ChatGroundingEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("REGRESSION: runChatGrounding reports the usage and cost it used to discard", async () => {
  const records = recordingSink();
  await collect(
    runChatGrounding(USER_ONLY, {
      env: { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      query: queryYielding([
        { type: "assistant", message: { content: [{ type: "text", text: "idle" }] } },
        { type: "result", subtype: "success", total_cost_usd: 0.031, usage: { input_tokens: 1800, output_tokens: 240 } },
      ]),
    }),
  );
  assert.equal(records.length, 1);
  assert.equal(records[0]?.provider, CHAT_GROUNDING_PROVIDER);
  assert.equal(records[0]?.inputTokens, 1800);
  assert.equal(records[0]?.outputTokens, 240);
  assert.equal(records[0]?.totalTokens, 2040);
  assert.equal(records[0]?.totalCostUsd, 0.031);
  assert.equal(records[0]?.isError, false);
});

test("runChatGrounding reports a stream with no result frame as a failed generation", async () => {
  const records = recordingSink();
  await collect(
    runChatGrounding(USER_ONLY, {
      env: { MINER_CODING_AGENT_PROVIDER: "agent-sdk" },
      query: queryYielding([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]),
    }),
  );
  assert.equal(records[0]?.isError, true);
  assert.equal((records[0]?.error as Error).message, "chat_grounding_no_result");
});

test("runChatGrounding emits nothing on the fail-closed provider path -- no model was reached", async () => {
  const records = recordingSink();
  await collect(runChatGrounding(USER_ONLY, { env: {} }));
  assert.equal(records.length, 0);
});
