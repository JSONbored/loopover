// The remote server's telemetry sink and span registry (#9525).
//
// The wrapper in dispatch-telemetry.ts is pure and covered separately; this covers the I/O half --
// both sides of every gate, and the guarantee that a sink failure never reaches the tool caller.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpToolCallTelemetry } from "@loopover/contract";
import { createDispatchTelemetrySink, recordMcpInitialize, recordMcpToolsList, type DispatchTelemetryEnv } from "../../src/mcp/dispatch-telemetry-sink";
import {
  getMcpDispatchSpanRunner,
  resetMcpDispatchSpanRunnerForTest,
  setMcpDispatchSpanRunner,
} from "../../src/mcp/dispatch-span-registry";

const call: McpToolCallTelemetry = { tool: "loopover_get_repo_context", category: "maintainer", surface: "remote", ok: true, durationMs: 4 };
const properties = { usage: { tool: call.tool }, mcpToolCall: { tool: call.tool } };

function env(overrides: Partial<DispatchTelemetryEnv> = {}): DispatchTelemetryEnv {
  return overrides as DispatchTelemetryEnv;
}

afterEach(() => {
  resetMcpDispatchSpanRunnerForTest();
  vi.restoreAllMocks();
});

describe("MCP dispatch span registry (#9525)", () => {
  it("is empty until a self-host boot fills it, and clears again", () => {
    expect(getMcpDispatchSpanRunner()).toBeUndefined();
    const runner = async <T>(_name: string, _attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => fn();
    setMcpDispatchSpanRunner(runner);
    expect(getMcpDispatchSpanRunner()).toBe(runner);
    setMcpDispatchSpanRunner(null);
    expect(getMcpDispatchSpanRunner()).toBeUndefined();
  });
});

describe("MCP dispatch telemetry sink (#9525)", () => {
  it("records nothing and defers nothing when POSTHOG_API_KEY is unset", () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(env(), (work) => deferred.push(work));
    sink.recordToolCall(call, properties);
    expect(deferred).toEqual([]);
  });

  it("treats a blank POSTHOG_API_KEY as unset", () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(env({ POSTHOG_API_KEY: "   " }), (work) => deferred.push(work));
    sink.recordToolCall(call, properties);
    expect(deferred).toEqual([]);
  });

  it("defers one capture when the key is set, and never rejects even with no reachable host", async () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(env({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" }), (work) => deferred.push(work));
    sink.recordToolCall(call, properties);
    expect(deferred).toHaveLength(1);
    // The never-throws guarantee: a PostHog init/capture/flush failure records nothing and resolves.
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("falls back to the US-cloud host when POSTHOG_HOST is unset", async () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(env({ POSTHOG_API_KEY: "phc_test" }), (work) => deferred.push(work));
    sink.recordToolCall(call, properties);
    expect(deferred).toHaveLength(1);
    // Reaches the real default host and fails there; the guarantee under test is that it resolves
    // rather than rejecting into the tool caller.
    await expect(deferred[0]).resolves.toBeUndefined();
  }, 20_000);

  it("captures nothing when the Worker exception key is unset", () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(env({ POSTHOG_API_KEY: "phc_test" }), (work) => deferred.push(work));
    sink.captureException(new Error("boom"), call);
    expect(deferred).toEqual([]);
  });

  it("defers an exception capture when the Worker key IS set -- a separate gate from the usage one", async () => {
    const deferred: Promise<unknown>[] = [];
    const sink = createDispatchTelemetrySink(
      env({ WORKER_POSTHOG_API_KEY: "phc_worker", WORKER_POSTHOG_HOST: "http://127.0.0.1:1" }),
      (work) => deferred.push(work),
    );
    // No POSTHOG_API_KEY here: the two gates are deliberately independent (see the sink's header),
    // so exception capture is on while usage events stay off.
    sink.recordToolCall(call, properties);
    sink.captureException(new Error("boom"), call);
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("passes the call through untouched when no span runner is registered", async () => {
    const sink = createDispatchTelemetrySink(env(), () => undefined);
    await expect(sink.withSpan("mcp.tool/x", { tool: "x" }, async () => "through")).resolves.toBe("through");
  });

  it("uses the registry's runner when a self-host boot has filled it", async () => {
    const seen: Array<{ name: string; attributes: Record<string, unknown> }> = [];
    setMcpDispatchSpanRunner(async (name, attributes, fn) => {
      seen.push({ name, attributes });
      return fn();
    });
    const sink = createDispatchTelemetrySink(env(), () => undefined);
    await expect(sink.withSpan("mcp.tool/x", { tool: "x" }, async () => "wrapped")).resolves.toBe("wrapped");
    expect(seen).toEqual([{ name: "mcp.tool/x", attributes: { tool: "x" } }]);
  });

  it("prefers an explicitly injected runner over the registry", async () => {
    setMcpDispatchSpanRunner(async () => {
      throw new Error("registry runner should not have been used");
    });
    let injectedCalls = 0;
    const injected = async <T>(_name: string, _attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
      injectedCalls += 1;
      return fn();
    };
    const sink = createDispatchTelemetrySink(env(), () => undefined, injected);
    await expect(sink.withSpan("mcp.tool/x", {}, async () => "injected")).resolves.toBe("injected");
    expect(injectedCalls).toBe(1);
  });
});

describe("LoopoverMcp telemetry-sink injection (#9525)", () => {
  it("routes a real tool call through the injected sink", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { LoopoverMcp } = await import("../../src/mcp/server");
    const { createTestEnv } = await import("../helpers/d1");

    const recorded: McpToolCallTelemetry[] = [];
    const sink = {
      recordToolCall: (entry: McpToolCallTelemetry) => recorded.push(entry),
      captureException: () => undefined,
      withSpan: async <T>(_name: string, _attributes: Record<string, unknown>, fn: () => Promise<T>) => fn(),
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sink-injection-test", version: "0.0.0" });
    await Promise.all([new LoopoverMcp(createTestEnv(), undefined, sink).createServer().connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: "loopover_get_repo_context", arguments: { owner: "acme", repo: "widgets" } });
    } finally {
      await client.close().catch(() => undefined);
    }

    // The chokepoint is the register wrapper, so this proves the injection reaches every tool
    // rather than just the one under test -- there is only one wrapper.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tool: "loopover_get_repo_context", category: "maintainer", surface: "remote" });
  }, 30_000);
});

describe("PostHog canonical MCP event recorders (#10175)", () => {
  const handshake = { clientName: "claude-code", clientVersion: "1.2.3" };
  const context = { sessionId: "ses_abc", serverName: "loopover", serverVersion: "3.18.4" };

  it("records no handshake and defers nothing when POSTHOG_API_KEY is unset", () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpInitialize(env(), (work) => deferred.push(work), handshake, context);
    expect(deferred).toEqual([]);
  });

  it("treats a blank POSTHOG_API_KEY as unset for the handshake", () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpInitialize(env({ POSTHOG_API_KEY: "   " }), (work) => deferred.push(work), handshake, context);
    expect(deferred).toEqual([]);
  });

  it("defers one handshake capture when the key is set, and never rejects", async () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpInitialize(env({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" }), (work) => deferred.push(work), handshake, context);
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("records a handshake with no context argument at all (the default)", async () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpInitialize(env({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" }), (work) => deferred.push(work), {});
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("records no tools/list and defers nothing when POSTHOG_API_KEY is unset", () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpToolsList(env(), (work) => deferred.push(work), ["a_tool"], context);
    expect(deferred).toEqual([]);
  });

  it("treats a blank POSTHOG_API_KEY as unset for tools/list", () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpToolsList(env({ POSTHOG_API_KEY: " " }), (work) => deferred.push(work), ["a_tool"], context);
    expect(deferred).toEqual([]);
  });

  it("defers one tools/list capture when the key is set, and never rejects", async () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpToolsList(env({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" }), (work) => deferred.push(work), ["a_tool", "b_tool"], context);
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("records a tools/list with no context argument at all (the default)", async () => {
    const deferred: Promise<unknown>[] = [];
    recordMcpToolsList(env({ POSTHOG_API_KEY: "phc_test", POSTHOG_HOST: "http://127.0.0.1:1" }), (work) => deferred.push(work), []);
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
  });

  it("carries the per-request analytics context on the sink, defaulting to an empty one", () => {
    // The context lives on the sink because it is per-REQUEST: the remote server builds one sink per
    // request, which is exactly the scope an MCP session id has.
    expect(createDispatchTelemetrySink(env(), () => undefined).context).toEqual({});
    expect(createDispatchTelemetrySink(env(), () => undefined, undefined, context).context).toBe(context);
  });
});
