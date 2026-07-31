import { afterEach, describe, expect, it } from "vitest";

import {
  buildChatPrompt,
  CHAT_GROUNDING_MCP_SERVER_NAME,
  CHAT_GROUNDING_PROVIDER,
  CHAT_GROUNDING_TOOL_NAMES,
  CHAT_REDACTED_TEXT,
  CHAT_SYSTEM_PROMPT,
  containsBlockedTerm,
  isValidChatMessages,
  redactBlockedText,
  resolveChatProviderError,
  resolveChatQuery,
  runChatGrounding,
  setMinerAiGenerationSink,
  type ChatGroundingEvent,
  type ChatMessage,
  type ChatQueryFn,
  type MinerAiGenerationRecord,
} from "../../packages/loopover-engine/src/index";

// Vitest mirror of packages/loopover-engine/test/chat-grounding.test.ts (#6517). codecov/patch is computed from
// this app vitest run (vitest.config coverage includes packages/loopover-engine/src/**), so the changed engine
// lines need a vitest test that imports the SRC directly — the engine's own node:test suite is not collected here.

const AGENT_SDK_ENV = { MINER_CODING_AGENT_PROVIDER: "agent-sdk" };

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

const USER_ONLY: ChatMessage[] = [{ role: "user", content: "what is my run state?" }];

describe("chat grounding tool allowlist (#6517)", () => {
  it("is exactly the 11 read-only loopover_miner_* tools", () => {
    // Invariant: a future accidental addition of a 12th tool (or a write-capable one) fails here, not just review.
    expect([...CHAT_GROUNDING_TOOL_NAMES]).toEqual([
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
    ]);
    expect(CHAT_GROUNDING_TOOL_NAMES).toHaveLength(11);
    for (const name of CHAT_GROUNDING_TOOL_NAMES) {
      expect(name.startsWith("loopover_miner_")).toBe(true);
    }
  });

  it("passes exactly that allowlist and the miner MCP server to the session", async () => {
    const captured: { input?: Parameters<ChatQueryFn>[0] } = {};
    await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([assistantText("ok")], captured),
        mcpServer: { command: "node", args: ["mcp.js"] },
      }),
    );
    expect(captured.input?.options.allowedTools).toEqual([...CHAT_GROUNDING_TOOL_NAMES]);
    expect(captured.input?.options.mcpServers).toEqual({
      [CHAT_GROUNDING_MCP_SERVER_NAME]: { command: "node", args: ["mcp.js"] },
    });
    expect(captured.input?.options.systemPrompt).toBe(CHAT_SYSTEM_PROMPT);
  });

  it("falls back to the packaged miner MCP server command when none is injected", async () => {
    const captured: { input?: Parameters<ChatQueryFn>[0] } = {};
    await collect(
      runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText("ok")], captured) }),
    );
    const server = captured.input?.options.mcpServers[CHAT_GROUNDING_MCP_SERVER_NAME];
    expect(server?.command).toBe("npx");
    expect(server?.args).toContain("loopover-miner-mcp");
  });
});

describe("chat grounding provider resolution (#6517)", () => {
  it("fails closed with no_coding_agent_configured when nothing is configured", async () => {
    expect(resolveChatProviderError({})?.code).toBe("no_coding_agent_configured");
    const events = await collect(runChatGrounding(USER_ONLY, { env: {} }));
    expect(events).toEqual([
      { type: "error", code: "no_coding_agent_configured", message: expect.any(String) },
      { type: "done" },
    ]);
  });

  it.each(["claude-cli", "codex-cli"])(
    "fails closed with chat_requires_agent_sdk_provider for the %s driver",
    async (provider) => {
      const env = { MINER_CODING_AGENT_PROVIDER: provider };
      expect(resolveChatProviderError(env)?.code).toBe("chat_requires_agent_sdk_provider");
      const events = await collect(runChatGrounding(USER_ONLY, { env }));
      expect(events).toEqual([
        { type: "error", code: "chat_requires_agent_sdk_provider", message: expect.stringContaining(provider) },
        { type: "done" },
      ]);
    },
  );

  it("never calls the model on a fail-closed provider path", async () => {
    let called = false;
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
        query: () => {
          called = true;
          return (async function* () {})();
        },
      }),
    );
    expect(called).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("returns undefined (chat usable) for the agent-sdk provider", () => {
    expect(resolveChatProviderError(AGENT_SDK_ENV)).toBeUndefined();
  });
});

describe("chat grounding streaming (#6517)", () => {
  it("emits text chunks then a terminating done", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([assistantText("your run "), assistantText("state is idle")]),
      }),
    );
    expect(events).toEqual([
      { type: "text", text: "your run " },
      { type: "text", text: "state is idle" },
      { type: "done" },
    ]);
  });

  it("emits tool_call for a tool_use block and tool_result for a tool-result message", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([
          {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", name: "loopover_miner_get_run_state", input: { repoFullName: "a/b" } }],
            },
          },
          {
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "loopover_miner_get_run_state", content: "{}" }] },
          },
        ]),
      }),
    );
    expect(events).toEqual([
      { type: "tool_call", tool: "loopover_miner_get_run_state", input: { repoFullName: "a/b" } },
      { type: "tool_result", tool: "loopover_miner_get_run_state", output: "{}" },
      { type: "done" },
    ]);
  });

  it("redacts a blocked term in tool_result output — string or structured — and passes clean output through (#8869)", async () => {
    async function toolResultOutput(content: unknown): Promise<unknown> {
      const events = await collect(
        runChatGrounding(USER_ONLY, {
          env: AGENT_SDK_ENV,
          query: queryYielding([{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "loopover_miner_get_run_state", content }] } }]),
        }),
      );
      return events.find((event): event is Extract<ChatGroundingEvent, { type: "tool_result" }> => event.type === "tool_result")?.output;
    }

    // An MCP tool's OWN output must not leak a blocklisted field, however it is shaped:
    expect(await toolResultOutput("your trust score is 9")).toBe(CHAT_REDACTED_TEXT); // string content
    expect(await toolResultOutput([{ type: "text", text: "your wallet balance is 5" }])).toBe(CHAT_REDACTED_TEXT); // array of blocks
    expect(await toolResultOutput({ nested: { payout: "42 TAO" } })).toBe(CHAT_REDACTED_TEXT); // nested object

    // Clean output — of any shape — passes through verbatim, structure preserved.
    expect(await toolResultOutput("run state is idle")).toBe("run state is idle");
    expect(await toolResultOutput([{ type: "text", text: "all good" }])).toEqual([{ type: "text", text: "all good" }]);
    expect(await toolResultOutput(7)).toBe(7); // a non-string/array/object primitive is never blocked
  });

  it("defaults a tool_use with no input to an empty object and a tool_result with no id to an empty name", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([
          { type: "assistant", message: { content: [{ type: "tool_use", name: "loopover_miner_ping" }] } },
          { type: "user", message: { content: [{ type: "tool_result", content: "pong" }] } },
        ]),
      }),
    );
    expect(events).toEqual([
      { type: "tool_call", tool: "loopover_miner_ping", input: {} },
      { type: "tool_result", tool: "", output: "pong" },
      { type: "done" },
    ]);
  });

  it("ignores unknown messages and malformed/non-array content without throwing", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([
          { type: "system", message: { content: [{ type: "text", text: "ignored" }] } },
          { type: "assistant", message: { content: "not-an-array" } },
          { type: "assistant" },
          { type: "user", message: { content: "not-an-array" } },
          { type: "assistant", message: { content: [null, { type: "other" }, { type: "text" }] } },
          { type: "user", message: { content: [null, { type: "text", text: "not-a-tool-result" }] } },
        ]),
      }),
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("turns a thrown SDK error into an error event still followed by done", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: () => {
          throw new Error("session boom");
        },
      }),
    );
    expect(events).toEqual([
      { type: "error", code: "chat_grounding_failed", message: "session boom" },
      { type: "done" },
    ]);
  });

  it("stringifies a non-Error rejection", async () => {
    const events = await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: () =>
          (async function* (): AsyncGenerator<Record<string, unknown>> {
            throw "plain string";
          })(),
      }),
    );
    expect(events[0]).toEqual({ type: "error", code: "chat_grounding_failed", message: "plain string" });
  });
});

describe("chat grounding privacy backstop (#6517)", () => {
  it("declines the blocked terms in the system prompt", () => {
    for (const term of ["wallet", "hotkey", "coldkey", "reward", "payout", "trust-score"]) {
      expect(CHAT_SYSTEM_PROMPT).toContain(term);
    }
  });

  it.each(["your trust score is 9", "wallet balance", "the hotkey is x", "coldkey", "reward pool", "payout due", "ranking"])(
    "redacts a text chunk containing a blocked term (%s)",
    async (text) => {
      expect(containsBlockedTerm(text)).toBe(true);
      expect(redactBlockedText(text)).toBe(CHAT_REDACTED_TEXT);
      const events = await collect(
        runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText(text)]) }),
      );
      expect(events).toEqual([{ type: "text", text: CHAT_REDACTED_TEXT }, { type: "done" }]);
    },
  );

  it("forwards a clean chunk verbatim", async () => {
    expect(containsBlockedTerm("your run state is idle")).toBe(false);
    expect(redactBlockedText("your run state is idle")).toBe("your run state is idle");
    const events = await collect(
      runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText("your run state is idle")]) }),
    );
    expect(events).toEqual([{ type: "text", text: "your run state is idle" }, { type: "done" }]);
  });
});

describe("chat message validation + prompt building (#6517)", () => {
  it("accepts a well-formed history ending in a user message", () => {
    expect(isValidChatMessages(USER_ONLY)).toBe(true);
    expect(
      isValidChatMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "status?" },
      ]),
    ).toBe(true);
  });

  it.each([
    ["not an array", "nope"],
    ["empty array", []],
    ["null entry", [null]],
    ["unknown role", [{ role: "system", content: "x" }]],
    ["non-string content", [{ role: "user", content: 1 }]],
    ["empty content", [{ role: "user", content: "" }]],
    ["last message not from the user", [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }]],
  ])("rejects %s", (_label, value) => {
    expect(isValidChatMessages(value)).toBe(false);
  });

  it("builds a prompt with prior turns replayed as labelled context", () => {
    expect(
      buildChatPrompt([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "status?" },
      ]),
    ).toBe("Conversation so far:\nUser: hi\nAssistant: hello\n\nUser: status?");
  });

  it("builds a bare prompt for a single user turn", () => {
    expect(buildChatPrompt(USER_ONLY)).toBe("User: what is my run state?");
  });

  it("tolerates an empty history (no last message) rather than throwing", () => {
    // isValidChatMessages rejects this upstream; buildChatPrompt still must not throw on the nullish arm.
    expect(buildChatPrompt([])).toBe("User: ");
  });
});

describe("chat grounding seam resolution (#6517)", () => {
  it("returns the injected query when provided", () => {
    const fake: ChatQueryFn = () => (async function* () {})();
    expect(resolveChatQuery({ query: fake })).toBe(fake);
  });

  it("falls back to the real SDK loop when none is injected, without opening a session", () => {
    // Binding the default must not import or call the SDK — only invoking the returned fn would.
    expect(typeof resolveChatQuery()).toBe("function");
    expect(typeof resolveChatQuery({})).toBe("function");
  });

  it("resolves the provider from process.env when no env is injected", async () => {
    // The `options.env ?? process.env` arm: this test process has no MINER_CODING_AGENT_PROVIDER, so chat
    // fails closed rather than reaching the model.
    const events = await collect(runChatGrounding(USER_ONLY));
    expect(events).toEqual([
      { type: "error", code: "no_coding_agent_configured", message: expect.any(String) },
      { type: "done" },
    ]);
  });
});

describe("chat grounding $ai_generation telemetry (#10200)", () => {
  function resultFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: "result", subtype: "success", total_cost_usd: 0.031, usage: { input_tokens: 1800, output_tokens: 240 }, ...extra };
  }

  function recordingSink(): MinerAiGenerationRecord[] {
    const records: MinerAiGenerationRecord[] = [];
    setMinerAiGenerationSink((record) => records.push(record));
    return records;
  }

  afterEach(() => {
    setMinerAiGenerationSink(undefined);
  });

  it("REGRESSION: reports the session's real usage and cost from the result frame it used to discard", async () => {
    // The driver read only `assistant`/`user` messages, so the SDK's own usage and cost were on the wire and
    // thrown away — the session was real spend and produced no telemetry at all.
    const records = recordingSink();
    const events = await collect(
      runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([assistantText("your run state is idle"), resultFrame()]) }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe(CHAT_GROUNDING_PROVIDER);
    expect(records[0]?.model).toBe("agent-sdk");
    expect(records[0]?.isError).toBe(false);
    expect(records[0]?.inputTokens).toBe(1800);
    expect(records[0]?.outputTokens).toBe(240);
    expect(records[0]?.totalTokens).toBe(2040);
    expect(records[0]?.totalCostUsd).toBe(0.031);
    expect(records[0]?.error).toBeUndefined();
    expect(records[0]?.latencyMs).toBeGreaterThanOrEqual(0);
    // The result frame carries usage, never conversational content, so it must not become a wire event.
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("omits usage the frame did not carry rather than fabricating zeros (#10207)", async () => {
    const records = recordingSink();
    await collect(
      runChatGrounding(USER_ONLY, {
        env: AGENT_SDK_ENV,
        query: queryYielding([resultFrame({ usage: undefined, total_cost_usd: undefined })]),
      }),
    );
    expect(records[0]?.inputTokens).toBeUndefined();
    expect(records[0]?.outputTokens).toBeUndefined();
    expect(records[0]?.totalTokens).toBeUndefined();
    expect(records[0]?.totalCostUsd).toBeUndefined();
    expect(records[0]?.isError).toBe(false);
  });

  it.each([
    ["a stream that ends with no result frame", [assistantText("partial")], "chat_grounding_no_result"],
    ["a result frame flagged is_error", [resultFrame({ is_error: true })], "chat_grounding_errored"],
    ["a non-success subtype", [resultFrame({ subtype: "error_max_turns" })], "chat_grounding_error_max_turns"],
    ["a non-string subtype", [resultFrame({ subtype: 7 })], "chat_grounding_unknown"],
  ])("reports %s as a failed generation", async (_label, messages, expectedError) => {
    const records = recordingSink();
    await collect(runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding(messages) }));
    expect(records).toHaveLength(1);
    expect(records[0]?.isError).toBe(true);
    expect((records[0]?.error as Error).message).toBe(expectedError);
  });

  it("captures the thrown-SDK path as a failure, alongside the error wire event", async () => {
    const records = recordingSink();
    const boom: ChatQueryFn = () =>
      (async function* () {
        throw new Error("sdk session refused");
      })();
    const events = await collect(runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: boom }));
    expect(records).toHaveLength(1);
    expect(records[0]?.isError).toBe(true);
    expect((records[0]?.error as Error).message).toBe("sdk session refused");
    expect(events).toContainEqual({ type: "error", code: "chat_grounding_failed", message: "sdk session refused" });
  });

  it("emits NOTHING on the fail-closed provider path — no model was reached", async () => {
    // A provider-config refusal is a request that produced no generation; reporting one would fabricate spend
    // that never happened. (The ORB gives that case its own separate `selfhost_ai_degraded` event, #10186.)
    const records = recordingSink();
    await collect(runChatGrounding(USER_ONLY, { env: {} }));
    await collect(runChatGrounding(USER_ONLY, { env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" } }));
    expect(records).toHaveLength(0);
  });

  it("stays a silent no-op when no host sink is registered", async () => {
    await expect(
      collect(runChatGrounding(USER_ONLY, { env: AGENT_SDK_ENV, query: queryYielding([resultFrame()]) })),
    ).resolves.toContainEqual({ type: "done" });
  });
});
