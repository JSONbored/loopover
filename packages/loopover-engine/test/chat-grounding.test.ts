import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildChatPrompt,
  CHAT_GROUNDING_MCP_SERVER_NAME,
  CHAT_GROUNDING_TOOL_NAMES,
  CHAT_REDACTED_TEXT,
  CHAT_SYSTEM_PROMPT,
  containsBlockedTerm,
  isValidChatMessages,
  redactBlockedText,
  resolveChatProviderError,
  resolveChatQuery,
  runChatGrounding,
  type ChatGroundingEvent,
  type ChatMessage,
  type ChatQueryFn,
} from "../dist/index.js";

// Read-only conversational grounding (#6517). Every test drives an injected fake ChatQueryFn — CI never opens a
// real agent-sdk session. Mirrored as a vitest suite at test/unit/chat-grounding-engine.test.ts, which is what
// codecov/patch actually measures for packages/loopover-engine/src/**.

const AGENT_SDK_ENV = { MINER_CODING_AGENT_PROVIDER: "agent-sdk" };
const USER_ONLY: ChatMessage[] = [{ role: "user", content: "what is my run state?" }];

function queryYielding(
  messages: Array<Record<string, unknown>>,
  captured?: { input?: Parameters<ChatQueryFn>[0] },
): ChatQueryFn {
  return (input) => {
    if (captured) captured.input = input;
    return (async function* () {
      yield* messages;
    })();
  };
}

function assistantText(text: string): Record<string, unknown> {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

async function collect(events: AsyncIterable<ChatGroundingEvent>): Promise<ChatGroundingEvent[]> {
  const out: ChatGroundingEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("the tool allowlist is exactly the 11 read-only loopover_miner_* tools", () => {
  assert.deepEqual(
    [...CHAT_GROUNDING_TOOL_NAMES],
    [
      "loopover_miner_ping",
      "loopover_miner_get_portfolio_dashboard",
      "loopover_miner_get_manage_status",
      "loopover_miner_list_claims",
      "loopover_miner_get_audit_feed",
      "loopover_miner_get_run_state",
      "loopover_miner_list_plans",
      "loopover_miner_get_plan",
      "loopover_miner_get_governor_decisions",
      "loopover_miner_status",
      "loopover_miner_get_calibration_report",
    ],
  );
  assert.equal(CHAT_GROUNDING_TOOL_NAMES.length, 11);
});

test("the session receives exactly the allowlist, the miner MCP server, and the system prompt", async () => {
  const captured: { input?: Parameters<ChatQueryFn>[0] } = {};
  await collect(
    runChatGrounding(USER_ONLY, {
      env: AGENT_SDK_ENV,
      query: queryYielding([assistantText("ok")], captured),
      mcpServer: { command: "node", args: ["mcp.js"] },
    }),
  );
  assert.deepEqual(captured.input?.options.allowedTools, [...CHAT_GROUNDING_TOOL_NAMES]);
  assert.deepEqual(captured.input?.options.mcpServers, {
    [CHAT_GROUNDING_MCP_SERVER_NAME]: { command: "node", args: ["mcp.js"] },
  });
  assert.equal(captured.input?.options.systemPrompt, CHAT_SYSTEM_PROMPT);
});

test("an unconfigured provider fails closed without calling the model", async () => {
  let called = false;
  const events = await collect(
    runChatGrounding(USER_ONLY, {
      env: {},
      query: () => {
        called = true;
        return (async function* () {})();
      },
    }),
  );
  assert.equal(called, false);
  assert.deepEqual(events[0]?.type, "error");
  assert.equal((events[0] as { code: string }).code, "no_coding_agent_configured");
  assert.deepEqual(events.at(-1), { type: "done" });
});

test("the single-turn CLI drivers fail closed with chat_requires_agent_sdk_provider", async () => {
  for (const provider of ["claude-cli", "codex-cli"]) {
    const events = await collect(runChatGrounding(USER_ONLY, { env: { MINER_CODING_AGENT_PROVIDER: provider } }));
    assert.equal((events[0] as { code: string }).code, "chat_requires_agent_sdk_provider");
    assert.deepEqual(events.at(-1), { type: "done" });
  }
  assert.equal(resolveChatProviderError(AGENT_SDK_ENV), undefined);
});

test("text chunks stream through and done terminates", async () => {
  const events = await collect(
    runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText("run state is idle")]) }),
  );
  assert.deepEqual(events, [{ type: "text", text: "run state is idle" }, { type: "done" }]);
});

test("tool_use and tool_result blocks become tool_call / tool_result events", async () => {
  const events = await collect(
    runChatGrounding(USER_ONLY, {
      env: AGENT_SDK_ENV,
      query: queryYielding([
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "loopover_miner_status", input: { verbose: true } }] },
        },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "loopover_miner_status", content: "{}" }] } },
      ]),
    }),
  );
  assert.deepEqual(events, [
    { type: "tool_call", tool: "loopover_miner_status", input: { verbose: true } },
    { type: "tool_result", tool: "loopover_miner_status", output: "{}" },
    { type: "done" },
  ]);
});

test("a blocked term in a text chunk is redacted, a clean chunk is forwarded verbatim", async () => {
  assert.equal(containsBlockedTerm("your trust score is 9"), true);
  assert.equal(redactBlockedText("your trust score is 9"), CHAT_REDACTED_TEXT);
  assert.equal(redactBlockedText("run state is idle"), "run state is idle");
  const events = await collect(
    runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText("your wallet balance")]) }),
  );
  assert.deepEqual(events, [{ type: "text", text: CHAT_REDACTED_TEXT }, { type: "done" }]);
});

test("a thrown session becomes an error event still followed by done", async () => {
  const events = await collect(
    runChatGrounding(USER_ONLY, {
      env: AGENT_SDK_ENV,
      query: () => {
        throw new Error("session boom");
      },
    }),
  );
  assert.deepEqual(events, [
    { type: "error", code: "chat_grounding_failed", message: "session boom" },
    { type: "done" },
  ]);
});

test("message validation accepts a user-terminated history and rejects malformed input", () => {
  assert.equal(isValidChatMessages(USER_ONLY), true);
  assert.equal(isValidChatMessages([]), false);
  assert.equal(isValidChatMessages("nope"), false);
  assert.equal(isValidChatMessages([{ role: "system", content: "x" }]), false);
  assert.equal(isValidChatMessages([{ role: "user", content: "" }]), false);
  assert.equal(
    isValidChatMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]),
    false,
  );
});

test("the prompt replays prior turns as labelled context", () => {
  assert.equal(
    buildChatPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "status?" },
    ]),
    "Conversation so far:\nUser: hi\nAssistant: hello\n\nUser: status?",
  );
  assert.equal(buildChatPrompt(USER_ONLY), "User: what is my run state?");
});

test("the injected seam resolves to the fake when given, and to a function otherwise", () => {
  const fake: ChatQueryFn = () => (async function* () {})();
  assert.equal(resolveChatQuery({ query: fake }), fake);
  assert.equal(typeof resolveChatQuery(), "function");
});
