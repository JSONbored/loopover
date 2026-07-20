import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the PostHog Node SDK so nothing hits the network: the class records every constructor + capture call
// on hoisted spies, and per-test flags let us force an init/capture failure to exercise the never-throw path.
// Mirrors test/unit/mcp-telemetry.test.ts's mock for the remote wrapper (#6235).
const h = vi.hoisted(() => ({
  constructSpy: vi.fn(),
  captureSpy: vi.fn(),
  state: { throwOnConstruct: false, throwOnCapture: false },
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
  },
}));

const { recordMcpToolCall } = await import("../../packages/loopover-mcp/lib/telemetry.js");

type LocalToolCallEvent = { tool: string; callerType?: "local"; ok: boolean; durationMs: number };
type CapturedMessage = { distinctId: string; event: string; properties: Record<string, unknown>; disableGeoip: boolean };

const EVENT: LocalToolCallEvent = { tool: "predict_gate", callerType: "local", ok: true, durationMs: 42 };

describe("recordMcpToolCall (local MCP wrapper, #6236)", () => {
  beforeEach(() => {
    h.constructSpy.mockClear();
    h.captureSpy.mockClear();
    h.state.throwOnConstruct = false;
    h.state.throwOnCapture = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is a safe no-op when telemetry is not opted in, even with an API key configured", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    recordMcpToolCall({ telemetryEnabled: false }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when telemetryEnabled is omitted (default OFF)", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    recordMcpToolCall({}, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("is a safe no-op when opted in but LOOPOVER_MCP_POSTHOG_API_KEY is unset", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", undefined);
    recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("treats a blank/whitespace API key as unconfigured", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "   ");
    recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).not.toHaveBeenCalled();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("captures exactly the allowlisted fields against the US-cloud default host when opted in and configured", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    recordMcpToolCall({ telemetryEnabled: true }, EVENT);

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
  });

  it("defaults callerType to local when the caller omits it", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    recordMcpToolCall({ telemetryEnabled: true }, { tool: "status", ok: false, durationMs: 0 });

    const message = h.captureSpy.mock.calls[0]![0] as CapturedMessage;
    expect(message.properties).toEqual({
      tool: "status",
      caller_type: "local",
      ok: false,
      duration_ms: 0,
    });
  });

  it("honors a LOOPOVER_MCP_POSTHOG_HOST override and carries a failed call verbatim", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "https://eu.i.posthog.com");
    recordMcpToolCall({ telemetryEnabled: true }, { tool: "check_slop_risk", callerType: "local", ok: false, durationMs: 7 });

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

  it("trims surrounding whitespace from the API key and host", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "  phc_test  ");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "  https://eu.i.posthog.com  ");
    recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://eu.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("falls back to the default host when LOOPOVER_MCP_POSTHOG_HOST is blank", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_HOST", "   ");
    recordMcpToolCall({ telemetryEnabled: true }, EVENT);
    expect(h.constructSpy).toHaveBeenCalledWith("phc_test", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  });

  it("never throws when the PostHog client fails to initialize", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnConstruct = true;
    expect(() => recordMcpToolCall({ telemetryEnabled: true }, EVENT)).not.toThrow();
    expect(h.captureSpy).not.toHaveBeenCalled();
  });

  it("never throws when capture itself fails", () => {
    vi.stubEnv("LOOPOVER_MCP_POSTHOG_API_KEY", "phc_test");
    h.state.throwOnCapture = true;
    expect(() => recordMcpToolCall({ telemetryEnabled: true }, EVENT)).not.toThrow();
    expect(h.captureSpy).toHaveBeenCalledTimes(1);
  });
});
