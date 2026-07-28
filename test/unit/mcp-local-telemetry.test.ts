import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the PostHog Node SDK so nothing hits the network: the class records every constructor + capture +
// flush call on hoisted spies, and per-test flags let us force an init/capture/flush failure to exercise
// the never-throw path. Mirrors test/unit/mcp-telemetry.test.ts's mock for the remote wrapper (#6235/#7233).
const h = vi.hoisted(() => ({
  constructSpy: vi.fn(),
  captureSpy: vi.fn(),
  captureExceptionSpy: vi.fn(),
  flushSpy: vi.fn(),
  state: {
    throwOnConstruct: false,
    throwOnCapture: false,
    throwOnFlush: false,
    /** Optional deferred flush body for proving await-before-resolve (#8690). */
    flushImpl: null as null | (() => Promise<void>),
  },
}));

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(apiKey: string, options: unknown) {
      h.constructSpy(apiKey, options);
      if (h.state.throwOnConstruct) throw new Error("posthog init failed");
    }
    capture(message: unknown): void {
      h.captureSpy(message);
      if (h.state.throwOnCapture) throw new Error("posthog capture failed");
    }
    captureException(error: unknown, distinctId: unknown, properties: unknown): void {
      h.captureExceptionSpy(error, distinctId, properties);
    }
    async flush(): Promise<void> {
      h.flushSpy();
      if (h.state.throwOnFlush) throw new Error("posthog flush failed");
      if (h.state.flushImpl) await h.state.flushImpl();
    }
  },
}));

const { recordMcpToolCall, recordStdioDispatchTelemetry, recordStdioToolTelemetry, wrapStdioToolHandler } = await import(
  "../../packages/loopover-mcp/lib/telemetry"
);

type LocalToolCallEvent = { tool: string; callerType?: "local"; ok: boolean; durationMs: number };
type CapturedMessage = { distinctId: string; event: string; properties: Record<string, unknown>; disableGeoip: boolean };

const EVENT: LocalToolCallEvent = { tool: "predict_gate", callerType: "local", ok: true, durationMs: 42 };

describe("recordMcpToolCall (local MCP wrapper, #6236)", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.captureExceptionSpy.mockClear();
    h.flushSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
    h.state.throwOnFlush = false;
    h.state.flushImpl = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a safe no-op when telemetry is not opted in, even with an API key configured", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordMcpToolCall({ telemetryEnabled: false }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when telemetryEnabled is omitted (default OFF)", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordMcpToolCall({}, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when opted in but LOOPOVER_MCP_POSTHOG_API_KEY is unset", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", undefined);
    await recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace API key as unconfigured", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "   ");
    await recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("captures exactly the allowlisted fields against the US-cloud default host when opted in and configured", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordMcpToolCall({ telemetryEnabled: true }, EVENT);

    expect(h.constructSpy).toHaveBeenCalledTimes(1);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });

    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.distinctId).toBe("loopover-mcp");
    expect(message.event).toBe("mcp_tool_call");
    expect(message.disableGeoip).toBe(true);
    expect(message.properties).toEqual({
      tool: "predict_gate",
      caller_type: "local",
      ok: true,
      duration_ms: 42,
    });
    // The allowlist is the whole payload -- no argument/source/wallet/hotkey/trust-score field can ride along.
    expect(Object.keys(message.properties).sort()).toEqual(["caller_type", "duration_ms", "ok", "tool"]);
    // #8690: the event is actually flushed, not just queued, before recordMcpToolCall's promise resolves.
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resolve until a delayed flush completes (#8690)", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    h.state.flushImpl = async () => {
      await flushGate;
    };

    let settled = false;
    const pending = recordMcpToolCall({ telemetryEnabled: true }, EVENT).then(() => {
      settled = true;
    });

    // Give the capture/flush path a turn on the microtask queue without releasing flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseFlush();
    await pending;
    expect(settled).toBe(true);
  });

  it("defaults callerType to local when the caller omits it", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordMcpToolCall({ telemetryEnabled: true }, { tool: "status", ok: false, durationMs: 0 });

    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toEqual({
      tool: "status",
      caller_type: "local",
      ok: false,
      duration_ms: 0,
    });
  });

  it("honors a LOOPOVER_MCP_POSTHOG_HOST override and carries a failed call verbatim", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "https://eu.i.posthog.com");
    await recordMcpToolCall({ telemetryEnabled: true }, { tool: "check_slop_risk", callerType: "local", ok: false, durationMs: 7 });

    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toEqual({
      tool: "check_slop_risk",
      caller_type: "local",
      ok: false,
      duration_ms: 7,
    });
  });

  it("trims surrounding whitespace from the API key and host", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "  phc_test  ");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "  https://eu.i.posthog.com  ");
    await recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("falls back to the default host when LOOPOVER_MCP_POSTHOG_HOST is blank", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "   ");
    await recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("never throws when the PostHog client fails to initialize", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnConstruct = true;
    await expect(recordMcpToolCall({ telemetryEnabled: true }, EVENT)).resolves.toBeUndefined();
    expect(h.captureSpy).not.toHaveBeenCalled();
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("never throws when capture itself fails", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnCapture = true;
    await expect(recordMcpToolCall({ telemetryEnabled: true }, EVENT)).resolves.toBeUndefined();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    // capture() threw, so flush() is never reached — same catch branch as the constructor failure above.
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("never throws when flush itself fails (#8690) — the event was captured/queued regardless", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnFlush = true;
    await expect(recordMcpToolCall({ telemetryEnabled: true }, EVENT)).resolves.toBeUndefined();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
  });
});

describe("recordStdioToolTelemetry / wrapStdioToolHandler (#8690)", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.captureExceptionSpy.mockClear();
    h.flushSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
    h.state.throwOnFlush = false;
    h.state.flushImpl = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("awaits flush before recordStdioToolTelemetry resolves when opted in", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    h.state.flushImpl = async () => {
      await flushGate;
    };

    let settled = false;
    const pending = recordStdioToolTelemetry(true, "loopover_status", true, 12).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    releaseFlush();
    await pending;
    expect(settled).toBe(true);
  });

  it("swallows a throwing recorder without rejecting (#6238)", async () => {
    await expect(
      recordStdioToolTelemetry(true, "loopover_status", true, 1, async () => {
        throw new Error("recorder boom");
      }),
    ).resolves.toBeUndefined();
    expect(h.constructSpy).not.toHaveBeenCalled();
  });

  it("wrapStdioToolHandler awaits telemetry on success and preserves the handler result", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    h.state.flushImpl = async () => {
      await flushGate;
    };

    const wrapped = wrapStdioToolHandler("loopover_demo", () => true, async () => ({ ok: true, isError: false }));
    let settled = false;
    const pending = wrapped().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFlush();
    await expect(pending).resolves.toEqual({ ok: true, isError: false });
    // TWO flushes since #9525: the legacy `mcp_tool_call` event this file has always asserted, plus
    // the shared dispatch pair (`usage_event` + `$mcp_tool_call`) all three servers now emit. The
    // legacy one stays because an operator's existing dashboards read it.
    expect(h.flushSpy).toHaveBeenCalledTimes(2);
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toMatchObject({ tool: "loopover_demo", ok: true });
  });

  it("wrapStdioToolHandler treats isError results as failed telemetry ok=false", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    const wrapped = wrapStdioToolHandler("loopover_demo", () => true, async () => ({ isError: true }));
    await wrapped();
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toMatchObject({ tool: "loopover_demo", ok: false });
  });

  it("wrapStdioToolHandler records ok=false then rethrows when the handler throws", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    const wrapped = wrapStdioToolHandler("loopover_demo", () => true, async () => {
      throw new Error("handler boom");
    });
    await expect(wrapped()).rejects.toThrow("handler boom");
    // Two flushes since #9525, same as the success path: the legacy event, then the shared pair.
    expect(h.flushSpy).toHaveBeenCalledTimes(2);
    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toMatchObject({ tool: "loopover_demo", ok: false });
    // The throw is additionally captured as an exception, grouped by tool and closed error code.
    expect(h.captureExceptionSpy).toHaveBeenCalledOnce();
    expect(h.captureExceptionSpy.mock.calls[0]![2]).toMatchObject({ mcp_tool: "loopover_demo" });
  });

  // #9525: the shared dispatch pair, driven directly so the branches the wrapper cannot reach are
  // covered -- a tool with no contract entry, and a failed call that carries no error value.
  it("recordStdioDispatchTelemetry sends nothing unless BOTH gates are open", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordStdioDispatchTelemetry(false, { tool: "loopover_lint_pr_text", ok: true, durationMs: 1 });
    expect(h.captureSpy).not.toHaveBeenCalled();

    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "");
    await recordStdioDispatchTelemetry(true, { tool: "loopover_lint_pr_text", ok: true, durationMs: 1 });
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("recordStdioDispatchTelemetry falls back to the unknown category for a tool with no contract entry", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordStdioDispatchTelemetry(true, { tool: "loopover_not_in_the_registry", ok: true, durationMs: 2, args: { a: 1 } });
    const usage = h.captureSpy.mock.calls.map((entry) => entry[0] as CapturedMessage).find((message) => message.event === "usage_event")!;
    expect(usage.properties).toMatchObject({ category: "unknown", surface: "stdio" });
    // No contract means no way to know the payload is safe, so it is withheld.
    const toolCall = h.captureSpy.mock.calls.map((entry) => entry[0] as CapturedMessage).find((message) => message.event === "$mcp_tool_call")!;
    expect(toolCall.properties).toMatchObject({ payloads_excluded: true });
  });

  it("recordStdioDispatchTelemetry captures an exception only when the failure carried one", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    await recordStdioDispatchTelemetry(true, { tool: "loopover_lint_pr_text", ok: false, durationMs: 2 });
    expect(h.captureExceptionSpy).not.toHaveBeenCalled();

    await recordStdioDispatchTelemetry(true, { tool: "loopover_lint_pr_text", ok: false, durationMs: 2, error: "a bare string" });
    expect(h.captureExceptionSpy).toHaveBeenCalledOnce();
  });

  it("wrapStdioToolHandler is a no-op for PostHog when telemetry is disabled", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    const wrapped = wrapStdioToolHandler("loopover_demo", () => false, async () => ({ ok: true }));
    await expect(wrapped()).resolves.toEqual({ ok: true });
    expect(h.constructSpy).not.toHaveBeenCalled();
  });
});
