import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the PostHog Node SDK so nothing hits the network: the class records every constructor + capture +
// flush call on hoisted spies, and per-test flags let us force an init/capture/flush failure to exercise
// the never-throw path. Mirrors test/unit/mcp-telemetry.test.ts's mock for the remote wrapper (#6235).
// `flushGate`, when set, is what the mocked flush awaits before resolving -- it stands in for the real
// network round-trip so #8690's tests can hold the "request" in flight and observe recordMcpToolCall's
// returned promise while it is still pending.
const h = vi.hoisted(() => ({
  constructSpy: vi.fn(),
  captureSpy: vi.fn(),
  flushSpy: vi.fn(),
  state: {
    throwOnConstruct: false,
    throwOnCapture: false,
    throwOnFlush: false,
    flushGate: null as Promise<void> | null,
    flushCompleted: false,
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
    async flush(): Promise<void> {
      h.flushSpy();
      if (h.state.throwOnFlush) throw new Error("posthog flush failed");
      if (h.state.flushGate) await h.state.flushGate;
      h.state.flushCompleted = true;
    }
  },
}));

const { recordMcpToolCall } = await import("../../packages/loopover-mcp/lib/telemetry.js");

type LocalToolCallEvent = { tool: string; callerType?: "local"; ok: boolean; durationMs: number };
type CapturedMessage = { distinctId: string; event: string; properties: Record<string, unknown>; disableGeoip: boolean };

const EVENT: LocalToolCallEvent = { tool: "predict_gate", callerType: "local", ok: true, durationMs: 42 };

/** Drain the microtask queue (and this loop turn's check phase) so a promise that CAN settle has settled. */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("recordMcpToolCall (local MCP wrapper, #6236)", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.flushSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
    h.state.throwOnFlush = false;
    h.state.flushGate = null;
    h.state.flushCompleted = false;
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
    // #8690 (mirroring the remote #7233): the event is actually flushed, not just queued, before the
    // returned promise resolves.
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
  });

  it("does not resolve until the mocked flush/network call completes (#8690)", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    // The mocked network round-trip resolves on a delay, standing in for a PostHog POST still in flight.
    h.state.flushGate = new Promise<void>((resolve) => setTimeout(resolve, 25));

    let settled = false;
    const pending = recordMcpToolCall({ telemetryEnabled: true }, EVENT).then(() => {
      settled = true;
    });

    // The event has been captured and the flush is in flight, but the promise must still be pending.
    // Before #8690, recordMcpToolCall had already returned synchronously at this point, with the network
    // call fired and forgotten.
    await drainMicrotasks();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(h.state.flushCompleted).toBe(false);

    await pending;
    // Resolution happened, and only after the mocked network call actually completed.
    expect(settled).toBe(true);
    expect(h.state.flushCompleted).toBe(true);
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
    // capture() threw, so flush() is never reached -- same catch branch as the constructor failure above.
    expect(h.flushSpy).not.toHaveBeenCalled();
  });

  it("never rejects when flush itself fails (#8690) -- the event was captured/queued regardless", async () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnFlush = true;
    await expect(recordMcpToolCall({ telemetryEnabled: true }, EVENT)).resolves.toBeUndefined();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
    expect(h.flushSpy).toHaveBeenCalledTimes(1);
  });
});
